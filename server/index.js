import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import {
  ingest,
  listActiveSessions,
  getSession,
  findLatestSessionByAgentType,
  listKnownProjects,
} from "./store.js";
import { generateAndSave, listReports, readReport, deleteReport } from "./report.js";
import { listRoles, getRole, classifyRole } from "./roles.js";
import { listSavedProjects, addSavedProject, removeSavedProject } from "./projects.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.FLEETVIEW_PORT ? Number(process.env.FLEETVIEW_PORT) : 4317;
const REPORT_INTERVAL_MIN = process.env.FLEETVIEW_REPORT_INTERVAL_MIN
  ? Number(process.env.FLEETVIEW_REPORT_INTERVAL_MIN)
  : 60;

const app = express();
app.use(express.json({ limit: "2mb" }));

// Reject cross-origin state-changing requests (localhost CSRF): with no auth,
// any webpage the user has open in a browser could otherwise POST to
// /api/roles/:id/run — which spawns an auto-approving agent that edits files
// and commits — just by the user visiting it while this server is running.
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

// This dashboard changes frequently during development; a stale cached
// app.js/index.html silently running old logic has been a repeat source of
// "it's not working" confusion. Never cache the GUI files.
app.use(express.static(path.join(__dirname, "..", "web"), { etag: false, lastModified: false, cacheControl: false, setHeaders: (res) => res.setHeader("Cache-Control", "no-store") }));

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

app.delete("/api/reports/:filename", (req, res) => {
  const ok = deleteReport(req.params.filename);
  if (!ok) return res.status(404).json({ error: "not found" });
  broadcast("report_deleted", { filename: path.basename(req.params.filename) });
  res.json({ ok: true });
});

// Dispatch a role's agent from the dashboard, in lieu of typing the prompt
// into a terminal. Spawned with --bg so the HTTP request returns immediately;
// the launched session reports into FleetView through the normal hooks like
// any other Claude Code session — no separate log viewer needed here.
// --agent selects the matching ~/.claude/agents/<id>.md persona (user-level,
// so it resolves under any project's cwd), and the resulting session's
// agent_type field is how the org-chart tab finds it again.
// The "--" sentinel stops claude's own arg parser from treating a prompt
// that happens to start with "-" as a flag (argv injection).
function dispatchRole(roleId, cwd, prompt) {
  const child = spawn(
    "claude",
    ["--bg", "--permission-mode", "auto", "--agent", roleId, "--", prompt],
    { cwd, detached: true, stdio: "ignore" }
  );
  child.on("error", (err) => console.error(`[roles/${roleId}] spawn failed:`, err.message));
  child.unref();
}

// --- Roles (org chart) ---
app.get("/api/roles", (_req, res) => {
  const roles = listRoles().map((r) => {
    const session = findLatestSessionByAgentType(r.id);
    return {
      ...r,
      session: session
        ? { id: session.id, cwd: session.cwd, status: session.status, updatedAt: session.updatedAt, turns: session.turns }
        : null,
    };
  });
  res.json(roles);
});

app.get("/api/projects", (_req, res) => {
  res.json(listKnownProjects());
});

// A plain <input> can't give us an absolute filesystem path (browsers only
// expose folder *names*, never real paths, for file/directory pickers) —
// so instead this asks the Node server, which runs locally with full OS
// access, to pop a native Windows folder-browse dialog and hand back
// whatever the user actually picked. Static script, no user input reaches
// the shell.
//
// This deliberately uses OpenFileDialog (tricked into folder-picking mode
// via ValidateNames/CheckFileExists=false + a placeholder FileName) rather
// than System.Windows.Forms.FolderBrowserDialog. FolderBrowserDialog under
// PowerShell's (.NET Framework) WinForms renders the old Windows XP-era
// tree browser with no address bar — no typing or pasting a path directly.
// OpenFileDialog uses the modern Explorer-style common item dialog, which
// has the same address bar / breadcrumb as a normal Explorer window.
app.post("/api/browse-folder", (_req, res) => {
  const script = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'FleetView: 対象プロジェクトのフォルダを選択'
$dialog.ValidateNames = $false
$dialog.CheckFileExists = $false
$dialog.CheckPathExists = $true
$dialog.FileName = 'このフォルダを選択'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output (Split-Path -Path $dialog.FileName -Parent)
}
`;
  execFile("powershell.exe", ["-NoProfile", "-Command", script], (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const selected = stdout.trim();
    res.json({ path: selected || null });
  });
});

// --- Saved target projects (組織図 dispatch panel dropdown) ---
app.get("/api/saved-projects", (_req, res) => {
  res.json(listSavedProjects());
});

app.post("/api/saved-projects", (req, res) => {
  const cwd = String(req.body?.path ?? "").trim();
  const name = String(req.body?.name ?? "").trim();
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return res.status(400).json({ error: "path must be an existing directory" });
  }
  if (!name) return res.status(400).json({ error: "name is required" });
  res.json(addSavedProject(name, cwd));
});

app.delete("/api/saved-projects", (req, res) => {
  const cwd = String(req.body?.path ?? "").trim();
  if (!cwd) return res.status(400).json({ error: "path is required" });
  res.json(removeSavedProject(cwd));
});

function validateDispatchInput(req, res) {
  const cwd = String(req.body?.cwd ?? "").trim();
  const instruction = String(req.body?.instruction ?? "").trim();
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    res.status(400).json({ error: "cwd must be an existing directory" });
    return null;
  }
  if (!instruction) {
    res.status(400).json({ error: "instruction is required" });
    return null;
  }
  if (instruction.startsWith("-")) {
    res.status(400).json({ error: "instruction must not start with -" });
    return null;
  }
  return { cwd, instruction };
}

// Explicit dispatch to a specific role, bypassing auto-routing.
app.post("/api/roles/:id/run", (req, res) => {
  const role = getRole(req.params.id);
  if (!role) return res.status(404).json({ error: "unknown role" });
  const input = validateDispatchInput(req, res);
  if (!input) return;
  try {
    dispatchRole(role.id, input.cwd, input.instruction);
    res.json({ ok: true, roleId: role.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Primary 組織図 flow: one shared instruction box, no role picked by hand —
// the instruction's wording decides which persona (and its tool
// restrictions) handles it. See classifyRole() for the routing rules.
app.post("/api/roles/dispatch", (req, res) => {
  const input = validateDispatchInput(req, res);
  if (!input) return;
  const roleId = classifyRole(input.instruction);
  try {
    dispatchRole(roleId, input.cwd, input.instruction);
    res.json({ ok: true, roleId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", payload: listActiveSessions() }));
});

// Bind to localhost only. This server has no auth, and /api/roles/:id/run
// spawns an auto-approving (no permission prompts) agent that edits files
// and commits — listening on 0.0.0.0 would let anyone on the LAN trigger that.
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
