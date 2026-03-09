#!/usr/bin/env node

/**
 * Minimal MCP HTTP server providing current UTC time
 * No external dependencies
 */

/* TEST WITH

## initialize
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "1.0" }
    } }'

## list tools
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }'


## get time
curl -X POST http://localhost:3000/mcp-server/v1 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "get_current_utc_time", "arguments": {} }}'

*/



import http, { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const println = console.log;
const logln = (...args) => { console.log(...args) }

const RESULT_FILE = 'zztmp.html'

const FETCH_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36"
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; // change to full path if needed

/* ================================
   MCP TYPES (2024 SPEC)
================================ */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

/* ================================
   CONFIG
================================ */

const PORT = 80;
const SERVER_NAME = "example-mcp-server";
const SERVER_VERSION = "1.0.0";

/* ================================
   UTIL: STREAM JSON RESPONSE
================================ */

function sendResponse(res: ServerResponse, response: JsonRpcResponse) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    "Transfer-Encoding": "chunked"
  });

  res.write(JSON.stringify(response));
  res.end();
}

function sendError(
  res: ServerResponse,
  id: string | number | null,
  code: number,
  message: string
) {
  sendResponse(res, {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
}

/* ================================
   TOOL IMPLEMENTATIONS
================================ */

function getCurrentUtcTime(): string {
  return new Date().toISOString();
}

async function fetchTextFromUrl(params: {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}> {
  const {
    url,
    method = "GET",
    body,
    headers = {}
  } = params;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/json",
        ...headers
      },
      body: body && method !== "GET" ? body : undefined
    });

    const responseText = await response.text();

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseText
    };
  } catch (error: any) {
    return {
      status: 0,
      statusText: "FETCH_ERROR",
      headers: {},
      body: error.message
    };
  }
}

/* ================================
   TOOL: HTML DUMP (HEADLESS CHROME)
================================ */

async function htmlDump(url: string): Promise<{
  success: boolean;
  exitCode: number | null;
  file?: string;
  stderr?: string;
  html?: string;
  error?: string;
}> {
//   const tmpFile = path.join(
//     os.tmpdir(),
//     `html-dump-${Date.now()}.html`
//   );
   const tmpFile = RESULT_FILE; //'zztmp.html'

  return new Promise((resolve) => {
    const chrome = spawn(CHROME_BIN, [
      "--headless",
      "--disable-gpu",
      "--dump-dom",
      "--virtual-time-budget=15000",
      url
    ]);

    let stdout = "";
    let stderr = "";

    chrome.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    chrome.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    chrome.on("error", (err) => {
      resolve({
        success: false,
        exitCode: null,
        error: err.message
      });
    });

    chrome.on("close", async (code) => {
      try {
        await fs.writeFile(tmpFile, stdout, "utf-8");
        const result = {
          success: code === 0,
          exitCode: code,
          file: tmpFile,
          stderr,
          html: stdout
        }

        println(JSON.stringify(result, null, 2))

        resolve(result);
      } catch (err: any) {
        resolve({
          success: false,
          exitCode: code,
          error: err.message,
          stderr
        });
      }
    });
  });
}

/* ================================
   MCP TOOL DEFINITIONS
================================ */

const tools = [
  {
    name: "getCurrentUtcTime",
    description: "Returns the current UTC time in ISO 8601 format.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "fetchTextFromUrl",
    description: "Fetches content from a URL. Supports custom method, headers, and body.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", default: "GET" },
        body: { type: "string" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" }
        }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "htmlDump",
    description: "Uses local Chrome headless to dump DOM to a file.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Webpage URL to dump using headless Chrome."
        }
      },
      required: ["url"],
      additionalProperties: false
    }
  }
];

/* ================================
   MCP HANDLER
================================ */

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse
) {
  let body = "";

  req.on("data", (chunk) => {
    body += chunk.toString();
  });

  req.on("end", async () => {
    let request: JsonRpcRequest;

    logln(` BODY: ${body}`);

    try {
      request = JSON.parse(body);
    } catch {
      return sendError(res, null, -32700, "Parse error");
    }

    if (request.jsonrpc !== "2.0" || !request.method) {
      return sendError(res, request.id ?? null, -32600, "Invalid Request");
    }

    try {
      switch (request.method) {

        case "initialize":
          return sendResponse(res, {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: {
                name: SERVER_NAME,
                version: SERVER_VERSION
              }
            }
          });

        case "tools/list":
          return sendResponse(res, {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: { tools }
          });

        case "tools/call": {
          const { name, arguments: args } = request.params ?? {};

          if (!name) {
            return sendError(res, request.id ?? null, -32602, "Missing tool name");
          }

          if (name === "getCurrentUtcTime") {
            const result = getCurrentUtcTime();
            return sendResponse(res, {
              jsonrpc: "2.0",
              id: request.id ?? null,
              result: {
                content: [{ type: "text", text: result }]
              }
            });
          }

          if (name === "fetchTextFromUrl") {
            if (!args?.url) {
              return sendError(res, request.id ?? null, -32602, "Missing 'url'");
            }

            const result = await fetchTextFromUrl(args);

            return sendResponse(res, {
              jsonrpc: "2.0",
              id: request.id ?? null,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }]
              }
            });
          }

          if (name === "htmlDump") {
            if (!args?.url) {
              return sendError(res, request.id ?? null, -32602, "Missing 'url'");
            }

            const result = await htmlDump(args.url);

            return sendResponse(res, {
              jsonrpc: "2.0",
              id: request.id ?? null,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }]
              }
            });
          }

          return sendError(res, request.id ?? null, -32601, "Tool not found");
        }

        default:
          return sendError(res, request.id ?? null, -32601, "Method not found");
      }
    } catch (err: any) {
      return sendError(res, request.id ?? null, -32603, err.message);
    }
  });
}

/* ================================
   HTTP SERVER
================================ */

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/mcp") {
    logln(`${(new Date()).toISOString()}  ${req.method} ${req.url}`);
    handleMcp(req, res);
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`MCP 2024 Streamable HTTP server running at http://localhost:${PORT}/mcp`);
});
