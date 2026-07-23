#!/usr/bin/env node
// Forwards a Claude Code hook event (JSON on stdin) to the local FleetView
// server. Must never block or fail the hook: always exits 0, with a short
// network timeout, regardless of whether the server is reachable.

import fs from "node:fs";

const PORT = process.env.FLEETVIEW_PORT || 4317;
const URL = `http://localhost:${PORT}/api/events`;
const TIMEOUT_MS = 1500;

function truncateDeep(value, maxLen = 2000) {
  if (typeof value === "string") {
    return value.length > maxLen ? value.slice(0, maxLen) + "…[truncated]" : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, maxLen));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, maxLen);
    return out;
  }
  return value;
}

// Hook payloads don't include Claude's reply text, only the transcript path.
// Stop fires once per completed turn, so a small tail-read here is cheap.
function extractLastAssistantText(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return undefined;
    const size = fs.statSync(transcriptPath).size;
    const readSize = Math.min(size, 60000);
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        const text = obj.message.content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) return text;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }
  if (!raw || !raw.trim()) process.exit(0);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  if (event.tool_input) event.tool_input = truncateDeep(event.tool_input);
  if (event.tool_response) event.tool_response = truncateDeep(event.tool_response, 500);
  if (event.hook_event_name === "Stop" || event.hook_event_name === "SubagentStop") {
    const response = extractLastAssistantText(event.transcript_path);
    if (response) event.assistant_response = response.length > 3000 ? response.slice(0, 3000) + "…" : response;
  }

  try {
    await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // FleetView server not running — silently ignore, never break the hook.
  }
  process.exit(0);
}

main();
