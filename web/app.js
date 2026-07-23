const STATUS_LABEL = {
  idle: "待機中",
  thinking: "思考中",
  running_tool: "ツール実行中",
  waiting_input: "入力待ち",
  compacting: "圧縮中",
  ended: "終了",
};

const sessions = new Map();

function fmtElapsed(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  return `${hr}時間前`;
}

function escapeHtml(s) {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function projectName(cwd) {
  if (!cwd) return "不明";
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

const TASK_HISTORY_SHOWN = 3;

function renderTaskHistory(session) {
  const history = session.promptHistory && session.promptHistory.length
    ? session.promptHistory
    : session.lastPrompt
    ? [{ ts: session.updatedAt, text: session.lastPrompt }]
    : [];
  if (history.length === 0) return "";

  const recent = history.slice(-TASK_HISTORY_SHOWN).reverse(); // newest first
  const hiddenCount = history.length - recent.length;

  const items = recent
    .map(
      (h, i) => `
        <div class="task-item${i === 0 ? " latest" : ""}">
          <span class="task-time">${escapeHtml(new Date(h.ts).toLocaleTimeString("ja-JP"))}</span>
          <span class="task-text" title="${escapeHtml(h.text)}">${escapeHtml(h.text)}</span>
        </div>`
    )
    .join("");

  return `
    <div class="card-task">
      <div class="card-task-label">依頼${history.length > 1 ? `（${history.length}件）` : ""}</div>
      ${items}
      ${hiddenCount > 0 ? `<div class="task-more">他 ${hiddenCount} 件</div>` : ""}
    </div>`;
}

// Work log entries: only PreToolUse (carries the actual action — command run,
// file touched, etc. via `detail`) and Notification are meaningful here.
// PostToolUse duplicates the same tool with no extra info, so it's dropped.
function renderFeed(session) {
  const items = (session.events || [])
    .filter((e) => e.hook === "PreToolUse" || e.hook === "Notification")
    .slice(-6)
    .reverse();
  if (items.length === 0) return '<div class="hint">イベント待ち</div>';
  return items
    .map((e) => {
      const text =
        e.hook === "Notification"
          ? `通知: ${e.detail || ""}`
          : e.detail
          ? `${e.tool}: ${e.detail}`
          : e.tool || e.hook;
      return `<div title="${escapeHtml(text)}">${escapeHtml(new Date(e.ts).toLocaleTimeString("ja-JP"))} ${escapeHtml(text)}</div>`;
    })
    .join("");
}

function renderCard(session) {
  const status = session.status || "idle";
  const label = STATUS_LABEL[status] || status;

  // Current activity: what the agent is doing right now (transient — overwritten by every event).
  const activityLine =
    status === "running_tool" && session.lastTool
      ? `<b>ツール:</b> ${escapeHtml(session.lastTool)}`
      : status === "waiting_input" && session.lastMessage
      ? `<b>通知:</b> ${escapeHtml(session.lastMessage)}`
      : status === "thinking"
      ? "思考中…"
      : session.lastMessage
      ? escapeHtml(session.lastMessage)
      : "&nbsp;";

  const isActive = ["running_tool", "thinking", "waiting_input", "compacting"].includes(status);

  return `
    <div class="card${isActive ? " is-active" : ""}" data-id="${escapeHtml(session.id)}" data-status="${escapeHtml(status)}">
      <div class="card-head">
        <span class="card-id" title="${escapeHtml(session.id)}">${escapeHtml(session.id.slice(0, 8))}…</span>
        <span class="badge ${status}">${label}</span>
      </div>
      ${renderTaskHistory(session)}
      <div class="card-current">${activityLine}</div>
      ${session.lastToolDetail ? `<div class="card-detail" title="${escapeHtml(session.lastToolDetail)}">${escapeHtml(session.lastToolDetail)}</div>` : ""}
      <div class="card-feed-label">作業ログ</div>
      <div class="card-feed">${renderFeed(session)}</div>
      <div class="card-footer">
        <span>${session.eventCount ?? 0} events</span>
        <span>${fmtElapsed(session.updatedAt)}</span>
      </div>
    </div>`;
}

function renderGrid() {
  const grid = document.getElementById("agent-grid");
  const empty = document.getElementById("empty-state");
  const list = Array.from(sessions.values());
  empty.hidden = list.length > 0;

  const groups = new Map();
  for (const s of list) {
    const key = projectName(s.cwd);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const groupOrder = Array.from(groups.entries())
    .map(([key, items]) => {
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      return { key, items, cwd: items[0].cwd, latest: Math.max(...items.map((i) => i.updatedAt)) };
    })
    .sort((a, b) => b.latest - a.latest);

  grid.innerHTML = groupOrder
    .map(
      (g) => `
      <section class="project-group">
        <h2 class="project-group-title">
          <span class="project-group-name">${escapeHtml(g.key)}</span>
          <span class="project-group-path" title="${escapeHtml(g.cwd)}">${escapeHtml(g.cwd)}</span>
          <span class="project-group-count">${g.items.length}</span>
        </h2>
        <div class="agent-grid">${g.items.map(renderCard).join("")}</div>
      </section>`
    )
    .join("");
}

function upsertSession(s) {
  sessions.set(s.id, s);
  renderGrid();
}

// --- WebSocket live feed ---
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  const dot = document.getElementById("conn-dot");

  ws.onopen = () => dot.classList.add("connected");
  ws.onclose = () => {
    dot.classList.remove("connected");
    setTimeout(connectWs, 2000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "snapshot") {
      for (const s of msg.payload) sessions.set(s.id, s);
      renderGrid();
    } else if (msg.type === "session_update") {
      upsertSession(msg.payload);
    } else if (msg.type === "report_generated") {
      loadReportsList();
    }
  };
}

// --- Tabs ---
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "reports") loadReportsList();
  });
});

// --- Reports ---
function mdToHtml(md) {
  const lines = md.split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    if (/^### /.test(line)) { closeList(); html += `<h3>${escapeHtml(line.slice(4))}</h3>`; continue; }
    if (/^## /.test(line)) { closeList(); html += `<h2>${escapeHtml(line.slice(3))}</h2>`; continue; }
    if (/^# /.test(line)) { closeList(); html += `<h1>${escapeHtml(line.slice(2))}</h1>`; continue; }
    if (/^- /.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineMd(line.slice(2))}</li>`;
      continue;
    }
    closeList();
    if (line.trim() === "") { html += ""; continue; }
    html += `<p>${inlineMd(line)}</p>`;
  }
  closeList();
  return html;

  function closeList() { if (inList) { html += "</ul>"; inList = false; } }
  function inlineMd(s) {
    let out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    return out;
  }
}

function parseReportDate(filename) {
  const m = filename.match(/^report-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("ja-JP");
}

async function loadReportsList() {
  const res = await fetch("/api/reports");
  const reports = await res.json();
  const list = document.getElementById("reports-list");
  if (reports.length === 0) {
    list.innerHTML = '<p class="hint">まだレポートがありません。</p>';
    return;
  }
  list.innerHTML = reports
    .map(
      (r) => `
        <button data-file="${escapeHtml(r.filename)}">
          <div class="report-item-title">${escapeHtml(r.title)}</div>
          <div class="report-item-date">${escapeHtml(parseReportDate(r.filename))}</div>
        </button>`
    )
    .join("");
  list.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      list.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const res = await fetch(`/api/reports/${encodeURIComponent(btn.dataset.file)}`);
      const md = await res.text();
      document.getElementById("report-view").innerHTML = mdToHtml(md);
    });
  });
  list.querySelector("button")?.click();
}

document.getElementById("gen-report-btn").addEventListener("click", async () => {
  const btn = document.getElementById("gen-report-btn");
  btn.disabled = true;
  btn.textContent = "生成中…";
  try {
    await fetch("/api/reports/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hours: 24 }),
    });
    await loadReportsList();
    document.querySelector('.tab-btn[data-tab="reports"]').click();
  } finally {
    btn.disabled = false;
    btn.textContent = "今すぐレポート生成";
  }
});

// --- Init ---
async function init() {
  const res = await fetch("/api/sessions");
  const list = await res.json();
  for (const s of list) sessions.set(s.id, s);
  renderGrid();
  connectWs();
  setInterval(renderGrid, 15000); // refresh relative timestamps
}

init();
