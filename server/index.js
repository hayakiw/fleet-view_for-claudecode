import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ingest, listActiveSessions, getSession, findLatestSessionByAgentType } from "./store.js";
import { generateAndSave, listReports, readReport } from "./report.js";
import { listTasks, addTask, setTaskDone, deleteTask } from "./tasks.js";
import { listRoles, getRole } from "./roles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");
const PORT = process.env.FLEETVIEW_PORT ? Number(process.env.FLEETVIEW_PORT) : 4317;
const REPORT_INTERVAL_MIN = process.env.FLEETVIEW_REPORT_INTERVAL_MIN
  ? Number(process.env.FLEETVIEW_REPORT_INTERVAL_MIN)
  : 60;

const app = express();
app.use(express.json({ limit: "2mb" }));

// Reject cross-origin state-changing requests (localhost CSRF): with no auth,
// any webpage the user has open in a browser could otherwise POST to
// /api/tasks/run — which spawns an auto-approving agent that edits files and
// commits — just by the user visiting it while this server is running.
// Browsers always send Origin on state-changing fetch/XHR; non-browser
// clients (our own hooks script, curl) don't set it and are unaffected.
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
app.use((req, res, next) => {
  if (["POST", "PATCH", "DELETE", "PUT"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: "forbidden origin" });
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, "..", "web")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// --- Hook ingestion endpoint (called by hooks/report-event.mjs) ---
app.post("/api/events", (req, res) => {
  try {
    const session = ingest(req.body);
    broadcast("session_update", session);
    res.json({ ok: true });
  } catch (err) {
    console.error("[api/events] error:", err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/sessions", (_req, res) => {
  res.json(listActiveSessions());
});

app.get("/api/sessions/:id", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// --- Reports ---
app.get("/api/reports", (_req, res) => {
  res.json(listReports());
});

app.get("/api/reports/:filename", (req, res) => {
  const content = readReport(req.params.filename);
  if (content === null) return res.status(404).json({ error: "not found" });
  res.type("text/markdown").send(content);
});

app.post("/api/reports/generate", (req, res) => {
  const periodMs = (Number(req.body?.hours) || 24) * 60 * 60 * 1000;
  const { filename, markdown, title } = generateAndSave(periodMs);
  broadcast("report_generated", { filename });
  res.json({ filename, markdown, title });
});

// --- Tasks (TASKS.md backlog, editable from the dashboard) ---
app.get("/api/tasks", (_req, res) => {
  res.json(listTasks());
});

app.post("/api/tasks", (req, res) => {
  try {
    const items = addTask(String(req.body?.text ?? ""));
    broadcast("tasks_updated", {});
    res.json(items);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/tasks/:index", (req, res) => {
  try {
    const items = setTaskDone(Number(req.params.index), !!req.body?.done);
    broadcast("tasks_updated", {});
    res.json(items);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete("/api/tasks/:index", (req, res) => {
  try {
    const items = deleteTask(Number(req.params.index));
    broadcast("tasks_updated", {});
    res.json(items);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Dispatch a role's agent from the dashboard, in lieu of typing the prompt
// into a terminal. Spawned with --bg so the HTTP request returns immediately;
// the launched session reports into FleetView through the normal hooks like
// any other Claude Code session — no separate log viewer needed here.
// --agent selects the matching .claude/agents/<id>.md persona, and the
// resulting session's agent_type field is how the org-chart tab finds it.
function dispatchRole(role) {
  const child = spawn(
    "claude",
    ["--bg", "--permission-mode", "auto", "--agent", role.id, role.prompt],
    { cwd: PROJECT_ROOT, detached: true, stdio: "ignore" }
  );
  child.on("error", (err) => console.error(`[roles/${role.id}] spawn failed:`, err.message));
  child.unref();
}

// --- Roles (org chart) ---
app.get("/api/roles", (_req, res) => {
  const roles = listRoles().map((r) => {
    const session = findLatestSessionByAgentType(r.id);
    return {
      ...r,
      session: session
        ? { id: session.id, status: session.status, updatedAt: session.updatedAt, turns: session.turns }
        : null,
    };
  });
  res.json(roles);
});

app.post("/api/roles/:id/run", (req, res) => {
  const role = getRole(req.params.id);
  if (!role) return res.status(404).json({ error: "unknown role" });
  try {
    dispatchRole(role);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tasks/run", (_req, res) => {
  const role = getRole("engineer");
  try {
    dispatchRole(role);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", payload: listActiveSessions() }));
});

// Bind to localhost only. This server has no auth, and /api/tasks/run spawns
// an auto-approving (no permission prompts) agent that edits files and
// commits — listening on 0.0.0.0 would let anyone on the LAN trigger that.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`FleetView server listening on http://localhost:${PORT}`);
  console.log(`Dashboard:      http://localhost:${PORT}`);
  console.log(`Events API:     POST http://localhost:${PORT}/api/events`);
});

// Periodic report generation
if (REPORT_INTERVAL_MIN > 0) {
  setInterval(() => {
    const { filename } = generateAndSave(REPORT_INTERVAL_MIN * 60 * 1000);
    console.log(`[report] generated ${filename}`);
    broadcast("report_generated", { filename });
  }, REPORT_INTERVAL_MIN * 60 * 1000).unref();
}
