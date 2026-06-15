// Simple streaming chat client using fetch() for OpenAI-compatible APIs
// Supports system prompts, /reset command, post-processing, and HTTP API.
// No external packages. Node 18+.

import readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import http from "node:http";

const println = console.log;

// -----------------------------
// CONFIGURATION
// -----------------------------
const API_KEY = process.env.OPENAI_API_KEY || "";
const API_URL = "http://localhost:2050/v1/chat/completions";
const HTTP_PORT = 2052;

const CHROME_BIN = "/usr/bin/chromium";
const WORKSPACE_PATH = process.cwd() + "/ws";
const TEMP_HTML_FILE = "tmp.htm";

const CONTEXT_SIZE = 28 * 1024;
const CHUNK_SIZE = 8192 * 3;
const CHUNK_BUFFER = Buffer.alloc(CHUNK_SIZE);

const SYSTEM_PROMPT = `You are a TypeScript frontend coding agent.
Do not give examples, make suggestions or show how you determined the answer unless requested.
When writing an output block, always suggest filename inside double square brackets before the output.
Agent can request user to do the following actions:
- provide UTC time with: \`##GET_UTC_TIME##\`.
- list files in the workspace with: \`##LIST_FILES##\`.
- paste the content of a file named <filename> with: \`##PASTE_FILE:<filename>##\`.
Each action request must start with double hash in a separate line.
Agent can only ask user to do one thing at a time.
Agent can only request files related to the task at hand.
Agent must quote all file types in triple backticks with type.
Do no ask user to paste files larger than ${CONTEXT_SIZE - 4096} bytes.
At the start of each session request the AGENTS.MD file from the user to obtain further instructions.
`;

println(`=== Current Workspace: ${WORKSPACE_PATH}  :  ${SYSTEM_PROMPT.length}`);

if (!API_KEY) console.error("Missing OPENAI_API_KEY environment variable");

// -----------------------------
// CHAT HISTORY
// -----------------------------
let messages = [{ role: "system", content: SYSTEM_PROMPT }];

// -----------------------------
// SIMPLE QUEUE (CLI + HTTP SAFE)
// -----------------------------
let isProcessing = false;
const pendingQueue: string[] = [];

function enqueuePrompt(input: string) {
  pendingQueue.push(input);
  processQueue();
}

async function processQueue() {
  if (isProcessing) return;
  const next = pendingQueue.shift();
  if (!next) return;

  isProcessing = true;
  try {
    await sendMessage(next);
  } finally {
    isProcessing = false;
    processQueue();
  }
}

// -----------------------------
// TOOLS
// -----------------------------
function getUtcTime() {
  return `{"time":"${new Date().toISOString()}"}`;
}

async function fileRead(fileName: string, offset: number): Promise<string> {
  const resolved = path.resolve(WORKSPACE_PATH, fileName);

  if (!resolved.startsWith(WORKSPACE_PATH + path.sep)) {
    return JSON.stringify({
      ok: false,
      reason: `file not found or outside workspace: ${fileName}`,
    });
  }

  let fileHandle: fs.FileHandle | null = null;

  try {
    fileHandle = await fs.open(resolved, "r");

    const { bytesRead } = await fileHandle.read(
      CHUNK_BUFFER,
      0,
      CHUNK_SIZE,
      offset,
    );

    if (bytesRead === 0) {
      return JSON.stringify({ ok: false, reason: "end of file" });
    }

    const chunk = CHUNK_BUFFER.toString("utf8", 0, bytesRead);
    const lastNL = chunk.lastIndexOf("\n");

    if (lastNL !== -1) {
      return chunk.slice(0, lastNL);
    } else {
      return chunk;
    }
  } catch (err) {
    return JSON.stringify({ ok: false, reason: String(err) });
  } finally {
    if (fileHandle) await fileHandle.close();
  }
}

async function fileWrite(
  fileName: string,
  content: string,
  isAppend: boolean,
): Promise<string> {
  try {
    const resolved = path.resolve(WORKSPACE_PATH, fileName);

    if (!resolved.startsWith(WORKSPACE_PATH + path.sep)) {
      return JSON.stringify({
        ok: false,
        reason: `file not found: ${fileName}`,
      });
    }

    await fs.mkdir(path.dirname(resolved), { recursive: true });

    if (isAppend) await fs.appendFile(resolved, content + "\n", "utf8");
    else await fs.writeFile(resolved, content + "\n", "utf8");

    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, reason: String(err) });
  }
}

async function listFiles() {
  async function walk(dir: string): Promise<any[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results: any[] = [];

    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);

      try {
        const stat = await fs.stat(fullPath);

        if (entry.isDirectory()) {
          results.push(...await walk(fullPath));
        } else {
          results.push({
            path: fullPath,
            name: entry.name,
            size: stat.size,
            lastModified: stat.mtime.toISOString(),
            isDirectory: false,
          });
        }
      } catch {
        results.push({
          path: fullPath,
          name: entry.name,
          size: null,
          lastModified: null,
          isDirectory: entry.isDirectory(),
          error: "stat failed",
        });
      }
    }));

    return results;
  }

  try {
    const items = await walk(WORKSPACE_PATH);

    return {
      success: true,
      workspacePath: WORKSPACE_PATH,
      itemCount: items.length,
      items,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// -----------------------------
// POST-PROCESSING
// -----------------------------
function extractFiles(input: string): { filename: string; content: string }[] {
  const results: any[] = [];
  const regex = /\[\[(.+?)\]\]\s*```[\w]*\n([\s\S]*?)```/g;

  let match;
  while ((match = regex.exec(input)) !== null) {
    results.push({ filename: match[1].trim(), content: match[2] });
  }

  return results;
}

let LAST_COMMAND = "";
const AGENT_REPLY = ">>> AGENT REPLY:";
const REPEAT_MESSAGE =
  "You already asked me to do that before. If you are going in a loop, stop now";

// -----------------------------
// USER REQUEST PROCESSOR
// -----------------------------
async function processUserRequest(reply: string) {
  const lines = reply.trimEnd().split("\n");

  for (const line of lines) {
    if (LAST_COMMAND === line.trim() && LAST_COMMAND !== "") {
      println(`${AGENT_REPLY}\n${REPEAT_MESSAGE}`);
      return sendMessage(REPEAT_MESSAGE);
    }

    if (line.startsWith("##GET_UTC_TIME##")) {
      LAST_COMMAND = line.trim();
      const utcTime = getUtcTime();
      println(`${AGENT_REPLY}\n${utcTime}`);
      return sendMessage(utcTime);
    }

    if (line.startsWith("##LIST_FILES##")) {
      LAST_COMMAND = line.trim();
      const dirList = JSON.stringify(await listFiles(), null, 2);
      println(`${AGENT_REPLY}\n${dirList}`);
      return sendMessage(dirList);
    }

    if (line.startsWith("##PASTE_FILE:")) {
      LAST_COMMAND = line.trim();

      const filename = line
        .replace("##PASTE_FILE:", "")
        .replace("##", "")
        .replaceAll("`", "");

      const content = await fileRead(filename, 0);

      println(`>>> AGENT REPLY:\n${content}`);
      return sendMessage(content);
    }
  }
}

// -----------------------------
// COMPLETED REPLY HANDLING
// -----------------------------
async function handleCompletedReply(reply: string) {
  const blocks = extractFiles(reply);

  for (const block of blocks) {
    await fileWrite(
      `${WORKSPACE_PATH}/${block.filename}`,
      block.content,
      false,
    );
  }

  await processUserRequest(reply);
}

// -----------------------------
// STREAM PARSER
// -----------------------------
async function readStream(response: Response) {
  if (!response.body) throw new Error("Missing response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let assistantContent = "";
  const toolCalls: any[] = [];
  let usage: any = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        return {
          role: "assistant",
          content: assistantContent,
          tool_calls: toolCalls.length ? toolCalls : undefined,
          usage,
        };
      }

      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      if (json.usage) usage = json.usage;

      const choice = json.choices?.[0];
      const delta = choice?.delta;

      if (!delta) continue;

      if (delta.content) {
        assistantContent += delta.content;
        process.stdout.write(delta.content);
      }
    }
  }
}

// -----------------------------
// SEND MESSAGE
// -----------------------------
async function sendMessage(userInput: string) {
  messages.push({ role: "user", content: userInput });

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!response.ok || !response.body) {
    console.error("Error:", response.status, response.statusText);
    return promptUser();
  }

  const assistantMessage = await readStream(response);

  println("");

  messages.push({
    role: "assistant",
    content: assistantMessage.content || "",
  });

  await handleCompletedReply(assistantMessage.content);

  if (assistantMessage.usage) {
    println(
      `[USAGE] prompt=${assistantMessage.usage.prompt_tokens} completion=${assistantMessage.usage.completion_tokens} total=${assistantMessage.usage.total_tokens}`,
    );
  }

  promptUser();
}

// -----------------------------
// HTTP SERVER
// -----------------------------
async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    // println(`== ${req.method} ${req.url}`);

    if (req.method === "GET") {
      const fileName = `.${req.url}`;
      if (await fileExists(fileName)) {
        const content = await fs.readFile(fileName, 'utf8')
        res.end(content);
        return;
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
    }

    if (req.method !== "POST" || req.url !== "/prompt") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));

    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");

        if (!parsed.input || typeof parsed.input !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'input'" }));
          return;
        }

        println(`> ${parsed.input}`);
        enqueuePrompt(parsed.input);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "queued" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  server.listen(HTTP_PORT, () => {
    println(`HTTP server running on http://localhost:${HTTP_PORT}`);
  });
}

// -----------------------------
// CLI LOOP
// -----------------------------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function promptUser() {
  rl.question("> ", (input) => {
    if (input.trim().toLowerCase() === "/reset") {
      messages = [{ role: "system", content: SYSTEM_PROMPT }];
      println("(conversation reset)");
      return promptUser();
    }

    if (input.trim().toLowerCase() === "/exit") {
      println("(Good bye!)");
      rl.close();
      process.exit(0);
    }

    enqueuePrompt(input);
  });
}

// -----------------------------
// BOOT
// -----------------------------
async function main() {
  console.log(
    "Simple Chat Client (type 'exit' to quit, '/reset' to clear history)",
  );

  startHttpServer();

  await new Promise((resolv) =>
    setTimeout(() => {
      resolv(true);
    }, 1000)
  );

  promptUser();
}

main();
