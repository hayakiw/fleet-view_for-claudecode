#!/usr/bin/env node
// Forwards a Claude Code hook event (JSON on stdin) to the local FleetView
// server. Must never block or fail the hook: always exits 0, with a short
// network timeout, regardless of whether the server is reachable.

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
  // Stop/SubagentStop already include this field directly — no need to read
  // the transcript file ourselves (an earlier version did, and it was both
  // slower and occasionally missed the response entirely).
  if (typeof event.last_assistant_message === "string" && event.last_assistant_message.length > 3000) {
    event.last_assistant_message = event.last_assistant_message.slice(0, 3000) + "…";
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
