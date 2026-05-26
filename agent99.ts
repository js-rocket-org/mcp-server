// Simple streaming chat client using fetch() for OpenAI-compatible APIs
// No external packages required. Node 18+ only.

// const API_URL = "http://localhost:2050/v1/chat/completions";
// const MODEL = "gpt-4o-gemma-4-E4B-it-Q5_K_M.gguf";

// Simple streaming chat client using fetch() for OpenAI-compatible APIs
// Supports system prompts, /reset command, and post-processing of completed replies.
// No external packages. Node 18+.

import readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const println = console.log;

// -----------------------------
// CONFIGURATION
// -----------------------------
const API_KEY = process.env.OPENAI_API_KEY || "";
const API_URL = "http://localhost:2050/v1/chat/completions";
// const MODEL = "gpt-4o-gemma-4-E4B-it-Q5_K_M.gguf";
// const MODEL = "Qwen3.5-9B-Q6_K.gguf";

const CHROME_BIN = "/usr/bin/chromium";
const WORKSPACE_PATH = process.cwd(); // "/home/me/ramdisk";
const TEMP_HTML_FILE = "tmp.htm";

const CHUNK_SIZE = 16384;
const CHUNK_BUFFER = Buffer.alloc(CHUNK_SIZE);

const TOOL_PREFIX = "[TOOL-START-8972]";

let SYSTEM_PROMPT =
  `You are an agent with access to 3 features. To use a feature simply start a line with:
  ${TOOL_PREFIX}
  followed by the feature name, then the feature parameters as a JSONL object all in one line.
  All features return a status JSONL object in the first line, followed by the result in the second line.
  The status JSONL will always have an 'ok' boolean key, indicating success or failure. Examples:
  {"ok":true}
  {"ok":false,"reason":"file not found"}

  The features you have access to are:
1. getUtcTime - get the current time
  - has no parameters, pass empty JSONL object {}
2. fileWrite - write a line (max 512 bytes) of text to a file.
  - example parameters: {"filename":"test.txt","isAppend":false,"line":"This is a line of text"}
3. fileRead - read a line of text from a file
  - example parameters: {"filename":"test.txt","offset":0}

example calls:
${TOOL_PREFIX}getUtcTime{}
${TOOL_PREFIX}fileRead{"filename":"x.txt","offset":0}

Rules:
- Wait for the feature to respond before trying to use another feature
`;

// SYSTEM_PROMPT='You are an agent'

println(`=== Current Workspace: ${WORKSPACE_PATH}  :  ${SYSTEM_PROMPT.length}`);

if (!API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable");
  // process.exit(1);
}

// -----------------------------
// CHAT HISTORY
// -----------------------------
let messages = [
  { role: "system", content: SYSTEM_PROMPT },
];

// -----------------------------
// TOOLS
// -----------------------------
function getUtcTime() {
  return `{"ok":true}\n${new Date().toISOString()}`;
}

async function fileRead(fileName: string, offset: number): Promise<string> {
  const resolved = path.resolve(WORKSPACE_PATH, fileName);
  if (!resolved.startsWith(WORKSPACE_PATH + path.sep)) {
    return JSON.stringify({
      errorMessage: `ERROR: file not found ${fileName}`,
    });
  }

  try {
    const fileHandle = await fs.open(fileName, "r");
    const { bytesRead } = await fileHandle.read(
      CHUNK_BUFFER,
      0,
      CHUNK_SIZE,
      offset,
    );
    await fileHandle.close();

    if (bytesRead === 0) {
      return JSON.stringify({ ok: false, reason: `end of file` });
    }

    // extract line
    const chunk = CHUNK_BUFFER.toString("utf8", 0, bytesRead);
    const newlineIndex = chunk.indexOf("\n");

    if (newlineIndex !== -1) {
      const line = chunk.slice(0, newlineIndex);
      const result = { ok: true, nextLineOffset: offset + line.length + 1 };
      return `${JSON.stringify(result)}\n${line}`;
    } else {
      // last line without EOL
      const line = chunk;
      const result = { ok: true, nextLineOffset: -1 };
      return `${JSON.stringify(result)}\n${line}`;
    }
  } catch (err) {
    return JSON.stringify({ ok: false, reason: `${err}` });
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

    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
  } catch (err1) {
    return JSON.stringify({ ok: false, reason: `${err1}` });
  }

  try {
    if (isAppend) {
      await fs.appendFile(fileName, content + "\n", { encoding: "utf8" });
    } else {
      await fs.writeFile(fileName, content + "\n", { encoding: "utf8" });
    }
    return JSON.stringify({ ok: true });
  } catch (err2) {
    return JSON.stringify({ ok: false, reason: `${err2}` });
  }
}

// -----------------------------
// POST-PROCESSING HOOK
// -----------------------------
async function handleCompletedReply(reply: string) {
  const lines = reply.split("\n");

  const cmdLine = lines.find((line) => line.startsWith(TOOL_PREFIX)) || null;

  if (!cmdLine) return;

  const cmdIndex = cmdLine.indexOf("{");

  if (cmdIndex <= 0) return;
  const commandPrefix = cmdLine.slice(0, cmdIndex);
  const command = commandPrefix.replace(TOOL_PREFIX, "");
  const commandSuffix = cmdLine.slice(cmdIndex);

  let params = {};
  try {
    params = JSON.parse(commandSuffix);
  } catch (err) {
    println(`Error can not parse parameters: ${err}`);
    await sendMessage(`Error can not parse parameters`);
    return;
  }

  let response = "error";
  switch (command) {
    case "getUtcTime":
      const utcTime = getUtcTime();
      println(`[getUtcTime =>] ${utcTime}`);
      await sendMessage(utcTime);
      return;
    case "fileRead":
      if (!params.filename || typeof params.offset !== "number") return;
      response = await fileRead(params.filename, params.offset);
      println(`[fileRead =>] ${response}`);
      await sendMessage(response);
      return;
    case "fileWrite":
      if (
        !params.filename || typeof params.line !== "string" ||
        typeof params.isAppend !== "boolean"
      ) return;
      // const fileContent = reply.substring(reply.indexOf("\n") + 1);
      response = await fileWrite(params.filename, params.line, params.isAppend);
      println(`[fileWrite =>] ${response}`);
      await sendMessage(response);
      return;
  }
}

// -----------------------------
// READLINE SETUP
// -----------------------------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// -----------------------------
// STREAMING CHAT REQUEST
// -----------------------------
async function sendMessage(userInput: string) {
  setTimeout(async () => {
    messages.push({ role: "user", content: userInput });

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        "parallel_tool_calls": false,
        // "tool_choice": "none",
        // model: MODEL,
        messages,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      console.error("Error:", response.status, response.statusText);
      promptUser();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let assistantReply = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          process.stdout.write("\n");

          messages.push({ role: "assistant", content: assistantReply });

          // 🔥 Call your custom post-processing function
          handleCompletedReply(assistantReply);

          promptUser();
          return;
        }

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            assistantReply += delta;
            process.stdout.write(delta);
          }
        } catch {
          // ignore malformed JSON
        }
      }
    }

    process.stdout.write("\n");
    promptUser();
  }, 2000);
}

// -----------------------------
// PROMPT LOOP
// -----------------------------
function promptUser() {
  rl.question("> ", (input: string) => {
    // RESET COMMAND
    if (input.trim().toLowerCase() === "/reset") {
      messages = [
        { role: "system", content: SYSTEM_PROMPT },
      ];
      console.log("(conversation reset)");
      promptUser();
      return;
    }

    if (input.trim().toLowerCase() === "exit") {
      rl.close();
      return;
    }

    sendMessage(input);
  });
}

console.log(
  "Simple Chat Client (type 'exit' to quit, '/reset' to clear history)",
);
promptUser();
