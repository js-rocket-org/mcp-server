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

const TMP_HTML_PATH = '/Volumes/RAMDisk/zztmp.htm'

let LAST_HTML_CONTENT = "";

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

function parseHtml(html: string) {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  class Node {
    type: number;
    tagName?: string;
    text?: string;
    attrs?: Record<string, string>;
    children: Node[];

    constructor(type: number, tagName?: string, text?: string) {
      this.type = type;
      this.tagName = tagName;
      this.text = text;
      this.attrs = {};
      this.children = [];
    }
  }

  const root = new Node(ELEMENT_NODE, "root");
  const stack = [root];
  let i = 0;

  while (i < html.length) {
    if (html[i] === "<") {
      if (html[i + 1] === "/") {
        const end = html.indexOf(">", i);
        if (end === -1) break;

        const tag = html.slice(i + 2, end).trim().toLowerCase();

        for (let j = stack.length - 1; j >= 0; j--) {
          if (stack[j].tagName === tag) {
            stack.splice(j);
            break;
          }
        }

        i = end + 1;
      } else {
        const end = html.indexOf(">", i);
        if (end === -1) break;

        const tagContent = html.slice(i + 1, end).trim();
        const space = tagContent.indexOf(" ");

        const tagName = (space > -1 ? tagContent.slice(0, space) : tagContent)
          .toLowerCase();

        const node = new Node(ELEMENT_NODE, tagName);

        if (tagName === "a") {
          const hrefMatch = tagContent.match(/href\s*=\s*["']([^"']+)["']/i);
          if (hrefMatch) node.attrs!.href = hrefMatch[1];
        }

        stack[stack.length - 1].children.push(node);

        if (!tagContent.endsWith("/")) stack.push(node);

        i = end + 1;
      }
    } else {
      const next = html.indexOf("<", i);
      const text = html.slice(i, next === -1 ? html.length : next);

      if (text.trim()) {
        stack[stack.length - 1].children.push(new Node(TEXT_NODE, undefined, text));
      }

      i += text.length;
    }
  }

  return root;
}

function serializeNode(node: any, allowed: string[], dangerous: string[]): string {
  if (node.type === 3) return node.text;

  if (dangerous.includes(node.tagName)) return "";

  const content = node.children
    .map((child: any) => serializeNode(child, allowed, dangerous))
    .join("");

  if (!allowed.includes(node.tagName)) return content;

  if (node.tagName === "a" && node.attrs?.href) {
    return `<a href="${node.attrs.href}">${content}</a>`;
  }

  return `<${node.tagName}>${content}</${node.tagName}>`;
}

function cleanHtml(html: string) {
  const allowedTags = [
    "html", "body", "div", "span", "p",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "em", "i", "strong", "b", "u", "small",
    "mark", "sub", "sup", "a", "abbr",
    "cite", "q", "code", "time",
    "ul", "ol", "li", "blockquote"
  ];

  const dangerousTags = ["script", "style", "noscript"];

  const root = parseHtml(html);

  return root.children
    .map((child: any) => serializeNode(child, allowedTags, dangerousTags))
    .join("");
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
    chrome.stderr.on("data", d => stderr += d.toString());

    const timeout = setTimeout(() => chrome.kill(), 20000);

    chrome.on("close", async (code) => {

      clearTimeout(timeout);

      LAST_HTML_CONTENT = cleanHtml(stdout);

      // Save files for debug purposes if path is defined
      if (TMP_HTML_PATH) {
        fs.writeFile(TMP_HTML_PATH, stdout, "utf-8");
        await fs.writeFile(`${TMP_HTML_PATH}l`, LAST_HTML_CONTENT, "utf-8");
      }

      resolve({
        success: code === 0,
        exitCode: code,
        fileSize: LAST_HTML_CONTENT.length,
        stderr
      });

    });

  });
}

async function htmlRead(params: { offset: number; length: number }) {

  const offset = Math.max(0, params.offset);
  let length = Math.min(params.length, MAX_HTML_READ_LENGTH);

  const data = LAST_HTML_CONTENT;
  const total = data.length;

  if (offset >= total) {
    return {
      content: "",
      offset,
      nextOffset: offset,
      totalFileSize: total,
      done: true
    };
  }

  if (offset + length > total) length = total - offset;

  const content = data.slice(offset, offset + length);

  const nextOffset = offset + length;

  return {
    content,
    offset,
    nextOffset,
    totalFileSize: total,
    done: nextOffset >= total
  };
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
    description: "Fetch webpage HTML using headless Chrome",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "htmlRead",
    description: "Read the HTML file last fetched with htmlDump in chunks",
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

          let result;

          if (name === "getCurrentUtcTime") {
            result = getCurrentUtcTime();
          } else if (name === "htmlDump") {
            result = await htmlDump(args?.url);
          } else if (name === "htmlRead") {
            result = await htmlRead(args);
          } else {
            return sendError(res, request.id ?? null, -32601, "Tool not found");
          }

          return sendResponse(res, {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: {
              content: [{ type: "text", text: JSON.stringify(result) }]
            }
          });

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
