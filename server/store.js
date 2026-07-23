import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const EVENTS_LOG = path.join(DATA_DIR, "events.jsonl");

const MAX_EVENTS_PER_SESSION = 200;
const MAX_TURN_HISTORY = 6;
const SESSION_STALE_MS = 1000 * 60 * 60 * 6; // 6h: drop open/idle sessions if untouched
const ENDED_STALE_MS = 1000 * 60 * 5; // 5min: a session that has actually ended shouldn't linger

fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {Map<string, object>} sessionId -> session state */
const sessions = new Map();

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    for (const s of raw.sessions ?? []) {
      // Migrate state saved before request/response were paired into `turns`.
      if (!s.turns) {
        s.turns = (s.promptHistory ?? []).map((h) => ({ ts: h.ts, prompt: h.text, response: null, responseTs: null }));
        if (s.lastResponse) {
          const last = s.turns[s.turns.length - 1];
          if (last) {
            last.response = s.lastResponse;
            last.responseTs = s.updatedAt;
          } else {
            s.turns.push({ ts: s.updatedAt, prompt: null, response: s.lastResponse, responseTs: s.updatedAt });
          }
        }
        delete s.promptHistory;
        delete s.lastPrompt;
        delete s.lastResponse;
      }
      // Self-heal state saved before the system-prompt filter existed (or written
      // by a race with an older server process) instead of requiring manual repair.
      s.turns = s.turns.filter((t) => !t.prompt || !isSystemInjectedPrompt(t.prompt));
      sessions.set(s.id, s);
    }
  } catch (err) {
    console.error("[store] failed to load state.json:", err.message);
  }
}

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload = { sessions: Array.from(sessions.values()) };
    fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), () => {});
  }, 500).unref();
}

function appendEventLog(event) {
  fs.appendFile(EVENTS_LOG, JSON.stringify(event) + "\n", () => {});
}

// "idle" must mean "genuinely waiting for the next human instruction" — only
// Stop (turn fully finished) and a fresh SessionStart qualify. PostToolUse does
// NOT mean idle: Claude is still deciding its next move (more tools, or a final
// reply) until Stop fires, so mapping it to idle made active work look stalled.
const STATUS_BY_HOOK = {
  SessionStart: "idle",
  UserPromptSubmit: "thinking",
  PreToolUse: "running_tool",
  PostToolUse: "thinking",
  Notification: "waiting_input",
  Stop: "idle",
  SubagentStop: "idle",
  SessionEnd: "ended",
  PreCompact: "compacting",
};

// Claude Code injects system content (background task completions, reminders,
// command output) through the same UserPromptSubmit hook as real user typing.
// These always start with an XML-ish tag; genuine human instructions don't.
// We keep the last *human* instruction visible instead of letting it be
// overwritten by unreadable system payloads.
const SYSTEM_PROMPT_RE = /^\s*<[a-zA-Z][\w-]*(\s|>)/;

function isSystemInjectedPrompt(text) {
  return SYSTEM_PROMPT_RE.test(text);
}

function summarizeToolInput(toolName, toolInput) {
  if (!toolInput) return undefined;
  try {
    if (toolName === "Bash") return toolInput.command;
    if (toolName === "Read" || toolName === "Edit" || toolName === "Write")
      return toolInput.file_path;
    if (toolName === "Grep" || toolName === "Glob")
      return toolInput.pattern;
    const s = JSON.stringify(toolInput);
    return s.length > 400 ? s.slice(0, 400) + "…" : s;
  } catch {
    return undefined;
  }
}

/**
 * Ingest a raw hook event (already normalized: hook_event_name, session_id, cwd, ...)
 * Updates in-memory session state and returns the updated session snapshot.
 */
function ingest(rawEvent) {
  const now = Date.now();
  const {
    hook_event_name: hookName,
    session_id: sessionId,
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
    message,
    prompt,
    source,
    reason,
    assistant_response: assistantResponse,
  } = rawEvent;

  if (!sessionId || !hookName) {
    throw new Error("session_id and hook_event_name are required");
  }

  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      cwd: cwd ?? "unknown",
      status: "idle",
      startedAt: now,
      updatedAt: now,
      lastTool: null,
      lastToolDetail: null,
      lastMessage: null,
      turns: [],
      eventCount: 0,
      events: [],
    };
    sessions.set(sessionId, session);
  }

  session.cwd = cwd ?? session.cwd;
  session.updatedAt = now;
  session.eventCount += 1;
  session.status = STATUS_BY_HOOK[hookName] ?? session.status;
  if (!session.turns) session.turns = []; // sessions persisted before this field existed

  if (hookName === "PreToolUse") {
    session.lastTool = toolName;
    session.lastToolDetail = summarizeToolInput(toolName, toolInput);
  }
  if (hookName === "UserPromptSubmit" && prompt && !isSystemInjectedPrompt(prompt)) {
    const text = prompt.length > 2000 ? prompt.slice(0, 2000) + "…" : prompt;
    session.turns.push({ ts: now, prompt: text, response: null, responseTs: null });
    if (session.turns.length > MAX_TURN_HISTORY) session.turns.shift();
  }
  if (hookName === "Notification" && message) {
    session.lastMessage = message;
  }
  if (hookName === "SessionStart" && source) {
    session.lastMessage = `session start (${source})`;
  }
  if (hookName === "SessionEnd") {
    session.lastMessage = reason ? `session end (${reason})` : "session end";
  }
  if ((hookName === "Stop" || hookName === "SubagentStop") && assistantResponse) {
    const text = assistantResponse.length > 2000 ? assistantResponse.slice(0, 2000) + "…" : assistantResponse;
    const last = session.turns[session.turns.length - 1];
    if (last && !last.response) {
      // Pair with the request that's still waiting on a reply.
      last.response = text;
      last.responseTs = now;
    } else {
      // No open turn to attach to (e.g. a background continuation whose
      // triggering prompt was filtered out) — still show the response
      // rather than dropping it, just without a paired request.
      session.turns.push({ ts: now, prompt: null, response: text, responseTs: now });
      if (session.turns.length > MAX_TURN_HISTORY) session.turns.shift();
    }
  }

  const entry = {
    ts: now,
    hook: hookName,
    tool: toolName,
    detail:
      hookName === "PreToolUse"
        ? summarizeToolInput(toolName, toolInput)
        : hookName === "UserPromptSubmit"
        ? prompt
        : hookName === "Notification"
        ? message
        : undefined,
  };
  session.events.push(entry);
  if (session.events.length > MAX_EVENTS_PER_SESSION) {
    session.events.shift();
  }

  persist();
  appendEventLog({ ...rawEvent, receivedAt: now });

  return session;
}

function listActiveSessions() {
  const now = Date.now();
  return Array.from(sessions.values())
    .filter((s) => now - s.updatedAt < (s.status === "ended" ? ENDED_STALE_MS : SESSION_STALE_MS))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function getSession(id) {
  return sessions.get(id) ?? null;
}

function readEventsSince(sinceMs) {
  if (!fs.existsSync(EVENTS_LOG)) return [];
  const lines = fs.readFileSync(EVENTS_LOG, "utf-8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (!sinceMs || ev.receivedAt >= sinceMs) out.push(ev);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

loadState();

export { ingest, listActiveSessions, getSession, readEventsSince, isSystemInjectedPrompt };
