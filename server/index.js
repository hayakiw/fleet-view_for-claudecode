import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingest, listActiveSessions, getSession } from "./store.js";
import { generateAndSave, listReports, readReport } from "./report.js";
import { listTasks, addTask, setTaskDone, deleteTask } from "./tasks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.FLEETVIEW_PORT ? Number(process.env.FLEETVIEW_PORT) : 4317;
const REPORT_INTERVAL_MIN = process.env.FLEETVIEW_REPORT_INTERVAL_MIN
  ? Number(process.env.FLEETVIEW_REPORT_INTERVAL_MIN)
  : 60;

const app = express();
app.use(express.json({ limit: "2mb" }));
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

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", payload: listActiveSessions() }));
});

server.listen(PORT, () => {
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
