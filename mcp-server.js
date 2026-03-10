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


const println = console.log;
const logln = (...args) => { console.log(...args) }

const RESULT_FILE = '/Volumes/RAMDisk/zztmp.htm'
const MAX_HTML_READ_LENGTH = 8192
let LAST_HTML_CONTENT = ""

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

const PORT = 3003;
const SERVER_NAME = "My MCP Server";
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



// HTML cleaner -----------------

/**
 * Simple DOM-like parser to strip unwanted tags
 * without relying on regex
 */

function parseHtml(html) {
  // Node types
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  class Node {
    constructor(type, tagName = null, text = "") {
      this.type = type;
      this.tagName = tagName;
      this.children = [];
      this.text = text;
    }
  }

  const root = new Node(ELEMENT_NODE, "root");
  const stack = [root];
  let i = 0;

  while (i < html.length) {
    if (html[i] === "<") {
      // Detect end tag
      if (html[i + 1] === "/") {
        const end = html.indexOf(">", i);
        if (end === -1) break;
        const tagName = html.slice(i + 2, end).trim().toLowerCase();
        // Pop stack until matching tag
        for (let j = stack.length - 1; j >= 0; j--) {
          if (stack[j].tagName === tagName) {
            stack.splice(j);
            break;
          }
        }
        i = end + 1;
      } else {
        // Start tag
        const end = html.indexOf(">", i);
        if (end === -1) break;
        const tagContent = html.slice(i + 1, end).trim();
        const spaceIndex = tagContent.indexOf(" ");
        const tagName = (spaceIndex > -1 ? tagContent.slice(0, spaceIndex) : tagContent).toLowerCase();

        const node = new Node(ELEMENT_NODE, tagName);
        stack[stack.length - 1].children.push(node);

        // Self-closing tags
        if (!tagContent.endsWith("/")) {
          stack.push(node);
        }

        i = end + 1;
      }
    } else {
      // Text node
      const nextTag = html.indexOf("<", i);
      const text = html.slice(i, nextTag === -1 ? html.length : nextTag);
      if (text.trim()) {
        stack[stack.length - 1].children.push(new Node(TEXT_NODE, null, text));
      }
      i += text.length;
    }
  }

  return root;
}

/**
 * Serialize the node tree back to HTML while filtering tags
 */
function serializeNode(node, allowedTags = [], dangerousTags = []) {
  if (node.type === 3) return node.text; // text node

  if (dangerousTags.includes(node.tagName)) return ""; // remove dangerous content

  let content = node.children.map(child => serializeNode(child, allowedTags, dangerousTags)).join("");

  if (allowedTags.includes(node.tagName)) {
    return `<${node.tagName}>${content}</${node.tagName}>`;
  }

  return content; // strip other tags but keep inner text
}

/**
 * Main function to clean HTML using simple DOM parser
 */
function cleanHtml(html) {
  const allowedTags = [
    "html","body",
    "div", "span", "p",
    "h1","h2","h3","h4","h5","h6",
    "em","i","strong","b","u","small","mark","sub","sup",
    "a","abbr","cite","q","code","time",
    "ul","ol","li","blockquote"
  ];

  const dangerousTags = ["script","style","noscript"];

  const root = parseHtml(html);
  return root.children.map(child => serializeNode(child, allowedTags, dangerousTags)).join("");
}

// HTML cleaner -----------------

/* ================================
   TOOL IMPLEMENTATIONS
================================ */

function getCurrentUtcTime(): string {
  return new Date().toISOString();
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
        LAST_HTML_CONTENT = cleanHtml(stdout)
        await fs.writeFile(tmpFile + 'l', LAST_HTML_CONTENT, "utf-8");

        const result = {
          success: code === 0,
          exitCode: code,
          fileName: tmpFile,
          stderr,
          fileSize: LAST_HTML_CONTENT.length
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
   TOOL: HTML READ (FROM htmlDump FILE)
================================ */

async function htmlRead(params: { offset: number; length: number }): Promise<{ content: string }> {
  // const filePath = RESULT_FILE;

  const offset = Math.max(0, params.offset ?? 0);
  let length = Math.min(params.length ?? MAX_HTML_READ_LENGTH, MAX_HTML_READ_LENGTH);

  try {
    // const data = await fs.readFile(filePath, "utf-8");
    const data = LAST_HTML_CONTENT;
    const fileSize = data.length;

    if (offset >= fileSize) {
      return { content: "" };
    }

    if (offset + length > fileSize) {
      length = fileSize - offset;
    }

    return { content: data.slice(offset, offset + length) };
  } catch (err: any) {
    return { content: "" }; // if file missing or error, return empty string
  }
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
    name: "htmlDump",
    description: "fetch a web page using local Chrome headless to dump DOM to a file",
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
  },
  {
    name: "htmlRead",
    description: "Read part of the last dumped HTML file in chunks.",
    inputSchema: {
      type: "object",
      properties: {
        offset: { type: "number", description: "Starting character offset." },
        length: { type: "number", description: `Number of characters to read (max ${MAX_HTML_READ_LENGTH}).` }
      },
      required: ["offset", "length"],
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
          } else if (name === "htmlDump") {
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
          } else if (name === "htmlRead") {
            const { offset, length } = args ?? {};
            if (offset == null || length == null) {
              return sendError(res, request.id ?? null, -32602, "Missing 'offset' or 'length'");
            }

            const result = await htmlRead({ offset, length });

            return sendResponse(res, {
              jsonrpc: "2.0",
              id: request.id ?? null,
              result: {
                content: [{ type: "text", text: result.content }]
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

const server = http.createServer(async (req: Request, res: ServerResponse) => {
  if (req.url === "/mcp") {
    if (req.method === "POST") {
      logln(`${(new Date()).toISOString()}  ${req.method} ${req.url}`);
      handleMcp(req, res);
    } else if (req.method === "OPTIONS") {
      sendResponse(res, "" as unknown as JsonRpcResponse)
    }
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`MCP 2024 Streamable HTTP server running at http://localhost:${PORT}/mcp`);
});
