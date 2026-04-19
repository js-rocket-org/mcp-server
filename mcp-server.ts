#!/usr/bin/env node

/**
 * Minimal MCP HTTP server providing current UTC time
 * No external dependencies
 */

/* TEST WITH

## initialize
curl -X POST http://localhost:3003/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "1.0" }
    } }'

## list tools
curl -X POST http://localhost:3003/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }'


## get time
curl -X POST http://localhost:3003/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "get_current_utc_time", "arguments": {} }}'

*/



import http, { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path"


// For output that always go to the screen
const println = console.log;
// For logging to debug console or file
const logln = (...args) => { console.log(...args) }

/* ================================
   CONFIG
================================ */

const PORT = 3003;
const SERVER_NAME = "My MCP Server";
const SERVER_VERSION = "1.0.0";

// 5MB
const MAX_BODY_SIZE = 5 * 1024 * 1024;
const MAX_HTML_READ_LENGTH = 8192;

const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WORKSPACE_PATH = '/Volumes/RAMDisk/work'
const TEMP_HTML_FILE = "tmp.htm"


const CHUNK_SIZE = 16384
const CHUNK_BUFFER = Buffer.alloc(CHUNK_SIZE);

/* ================================
   TYPES
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
  content?: any;
  error?: {
    code: number;
    message: string;
  };
}

/* ================================
   HTTP HELPERS
================================ */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

function sendResponse(res: ServerResponse, response: JsonRpcResponse) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    ...CORS_HEADERS
  });

  res.end(JSON.stringify(response));
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
   URL VALIDATION
================================ */

function validateUrl(url: string) {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs allowed");
  }

  /* Allow local urls
    const host = parsed.hostname;
  
    if (
      host === "localhost" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("169.254.")
    ) {
      throw new Error("Private network URLs not allowed");
    }
  */

  return parsed.toString();
}

/* ================================
   SIMPLE HTML CLEANER
================================ */

function filterXml(xml: string, disallowedTags: string[]): string {
  const disallowed = new Set(disallowedTags.map(t => t.toLowerCase()));

  let output = "";
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const char = xml[i];

    if (char !== "<") {
      output += char;
      i++;
      continue;
    }

    const tagStart = i;
    const tagEnd = xml.indexOf(">", tagStart);
    if (tagEnd === -1) {
      output += xml.slice(i);
      break;
    }

    const rawTag = xml.slice(tagStart + 1, tagEnd).trim();

    const isClosing = rawTag.startsWith("/");
    const cleaned = isClosing ? rawTag.slice(1).trim() : rawTag;

    // Extract tag name
    const tagName = cleaned
      .split(/\s|\/>/)[0]
      .replace(/\/$/, "")
      .toLowerCase();

    const isSelfClosing = /\/\s*$/.test(rawTag);

    // Allowed tag → keep as-is
    if (!disallowed.has(tagName)) {
      output += xml.slice(tagStart, tagEnd + 1);
      i = tagEnd + 1;
      continue;
    }

    // Disallowed + self-closing → remove only this tag
    if (isSelfClosing) {
      i = tagEnd + 1;
      continue;
    }

    // Disallowed + closing tag → skip it
    if (isClosing) {
      i = tagEnd + 1;
      continue;
    }

    // Disallowed + normal opening tag → remove entire block
    const closingTag = `</${tagName}>`;
    const lowerXml = xml.toLowerCase();
    const closeIndex = lowerXml.indexOf(closingTag, tagEnd + 1);

    if (closeIndex === -1) {
      // malformed XML: remove only the opening tag
      i = tagEnd + 1;
      continue;
    }

    // Skip entire element including closing tag
    i = closeIndex + closingTag.length;
  }

  return output;
}


function cleanHtml(html: string): string {
  const disAllowedTag = ["style", "script", "template", "link", "svg", "a", "head", "iframe",
    "nav", "footer", "header", "input", "button"]

  return filterXml(html, disAllowedTag)
}


/* ================================
   TOOL IMPLEMENTATIONS
================================ */

function getCurrentUtcTime() {
  return new Date().toISOString();
}

async function htmlDump(url: string) {

  const validatedUrl = validateUrl(url);

  return new Promise((resolve) => {

    const chrome = spawn(CHROME_BIN, [
      "--headless",
      "--disable-gpu",
      "--disable-extensions",
      "--dump-dom",
      "--virtual-time-budget=18000",
      validatedUrl
    ]);

    let stdout = "";
    let stderr = "";

    chrome.stdout.on("data", d => stdout += d.toString());
    // chrome.stderr.on("data", d => stderr += d.toString());

    const timeout = setTimeout(() => chrome.kill(), 20000);

    chrome.on("close", async (code) => {

      clearTimeout(timeout);

      const CLEANED_HTML_CONTENT = stdout.startsWith('<') ? cleanHtml(stdout) : stdout;
      // const LAST_HTML_CONTENT = stdout;

      const TMP_HTML_PATH = `${WORKSPACE_PATH}/${TEMP_HTML_FILE}`
      if (TMP_HTML_PATH) {
        // fs.writeFile(`${TMP_HTML_PATH}l`, LAST_HTML_CONTENT, "utf-8");
        await fs.writeFile(`${TMP_HTML_PATH}`, CLEANED_HTML_CONTENT, "utf-8");
      }

      resolve({
        success: code === 0,
        exitCode: code,
        fileName: TEMP_HTML_FILE,
        fileSize: CLEANED_HTML_CONTENT.length,
        // stderr
      });

    });

  });
}


async function fileRead(fileName: string, offset: number) {
  const resolved = path.resolve(WORKSPACE_PATH, fileName);
  if (!resolved.startsWith(WORKSPACE_PATH + path.sep)) {
    return { errorMessage: `ERROR: file not found ${fileName}` };
  }

  const fileHandle = await fs.open(fileName, 'r');

  try {
    const { bytesRead } = await fileHandle.read(CHUNK_BUFFER, 0, CHUNK_SIZE, offset);

    const result = {
      nextOffset: bytesRead !== CHUNK_SIZE ? '*' : offset + CHUNK_SIZE,
      fileContent: CHUNK_BUFFER.toString('utf8', 0, bytesRead),
    };
    return `${result.nextOffset} ${result.fileContent}`;
  } finally {
    await fileHandle.close();
  }
}


async function fileWrite(fileName: string, content: string, isAppend: boolean) {
  try {
    const resolved = path.resolve(WORKSPACE_PATH, fileName);
    if (!resolved.startsWith(WORKSPACE_PATH + path.sep)) {
      return `error: file not found ${fileName}`;
    }

    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
  } catch (err1) {
    return `error: ${err1}`;
  }

  try {
    if (isAppend) {
      await fs.appendFile(fileName, content + "\n", { encoding: "utf8" });
    } else {
      await fs.writeFile(fileName, content + "\n", { encoding: "utf8" });
    }
    return "success";
  } catch (err2) {
    return `error: ${err2}`;
  }
}


/* ================================
   MCP TOOL DEFINITIONS
================================ */

const tools = [
  {
    name: "getCurrentUtcTime",
    description: "Returns the current UTC time.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "htmlDump",
    description: "Fetch a Web page or URL into a file. Returns file name",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "fileRead",
    description: `Read file in chunks. Call multiple times to read whole file. ` +
      "Returns next byte offset or * if no more content, followed by space, then the chunk content",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "name of file in workspace" },
        offset: { type: "number", description: "byte offset to read from" },
      },
      required: ["filename", "offset"],
      additionalProperties: false
    }
  },
  {
    name: "fileWrite",
    description: "Write string content to a file, with isAppend flag to append to existing file instead of overwrite or create",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "name of file in workspace" },
        content: { type: "string", description: "string content to write or append to file" },
        isAppend: { type: "boolean", description: "flag to indicate append or overwrite/create file" },
      },
      required: ["filename", "offset"],
      additionalProperties: false
    }
  }
];

/* ================================
   MCP HANDLER
================================ */

async function handleMcp(req: IncomingMessage, res: ServerResponse) {

  let body = "";

  req.on("data", chunk => {

    body += chunk.toString();

    if (body.length > MAX_BODY_SIZE) {
      sendError(res, null, -32000, "Request too large");
      req.destroy();
    }

  });

  req.on("end", async () => {

    let request: JsonRpcRequest;

    try {
      request = JSON.parse(body);
    } catch {
      return sendError(res, null, -32700, "Parse error");
    }

    if (request.jsonrpc !== "2.0" || !request.method) {
      return sendError(res, request.id ?? null, -32600, "Invalid Request");
    }

    try {
      logln(`  ${request.method}  ${(request.method === 'tools/call' ? ' => ' + (JSON.stringify(request.params ?? {})) : '')}`)

      switch (request.method) {

        case "initialize":
          return sendResponse(res, {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
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

          let toolResult;

          if (name === "getCurrentUtcTime") {
            toolResult = getCurrentUtcTime();
          } else if (name === "htmlDump") {
            toolResult = await htmlDump(args?.url);
          } else if (name === "fileRead") {
            toolResult = await fileRead(args?.filename, args?.offset);
          } else if (name === "fileWrite") {
            toolResult = await fileWrite(args?.filename, args?.content, args?.isAppend)
          } else {
            return sendError(res, request.id ?? null, -32601, "Tool not found");
          }

          const mcpResponse: JsonRpcResponse = {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: {
              content: [
                { type: 'text', text: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult) }
              ]
            }
          }
          // println(JSON.stringify(mcpResponse, null, 2))
          return sendResponse(res, mcpResponse);

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

const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.url === "/mcp" && req.method === "POST") {
    println(`${new Date().toISOString()} POST /mcp`);
    handleMcp(req, res);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");

});

server.listen(PORT, () => {
  println(`MCP server running at http://localhost:${PORT}/mcp`);
});
