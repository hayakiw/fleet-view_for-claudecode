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
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function projectName(cwd) {
  if (!cwd) return "不明";
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

// Each turn pairs a request with the response that answered it, so a reply
// never appears disconnected from what it was replying to. A turn can have
// a null prompt (e.g. a background continuation with no captured human
// instruction) — shown with a placeholder rather than hidden.
function renderTaskHistory(session) {
  const turns = session.turns || [];
  if (turns.length === 0) return "";

  const recent = [...turns].reverse(); // newest first; scroll handles overflow, no hard cap

  const items = recent
    .map((t, i) => {
      const promptText = t.prompt || "（依頼なし・バックグラウンド継続作業）";
      const responseHtml = t.response
        ? `<div class="task-response" data-tooltip="${escapeHtml(t.response)}">→ ${escapeHtml(t.response)}</div>`
        : "";
      return `
        <div class="task-item${i === 0 ? " latest" : ""}">
          <div class="task-row">
            <span class="task-time">${escapeHtml(new Date(t.ts).toLocaleTimeString("ja-JP"))}</span>
            <span class="task-text${t.prompt ? "" : " task-text-empty"}" data-tooltip="${escapeHtml(promptText)}">${escapeHtml(promptText)}</span>
          </div>
          ${responseHtml}
        </div>`;
    })
    .join("");

  return `
    <div class="card-task">
      <div class="card-task-label">やり取り${turns.length > 1 ? `（${turns.length}件）` : ""}</div>
      <div class="task-items">${items}</div>
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
      return `<div data-tooltip="${escapeHtml(text)}">${escapeHtml(new Date(e.ts).toLocaleTimeString("ja-JP"))} ${escapeHtml(text)}</div>`;
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
        <span class="card-id" data-tooltip="${escapeHtml(session.id)}">${escapeHtml(session.id.slice(0, 8))}…</span>
        <span class="badge ${status}">${label}</span>
      </div>
      ${renderTaskHistory(session)}
      <div class="card-current">${activityLine}</div>
      ${session.lastToolDetail ? `<div class="card-detail" data-tooltip="${escapeHtml(session.lastToolDetail)}">${escapeHtml(session.lastToolDetail)}</div>` : ""}
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
          <span class="project-group-path" data-tooltip="${escapeHtml(g.cwd)}">${escapeHtml(g.cwd)}</span>
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
    if (btn.dataset.tab === "org") loadRoles();
  });
});

// --- Org chart (role-based agents, any project) ---
async function loadProjectList() {
  const res = await fetch("/api/projects");
  const projects = await res.json();
  const datalist = document.getElementById("org-project-list");
  datalist.innerHTML = projects.map((p) => `<option value="${escapeHtml(p)}"></option>`).join("");
}

async function loadRoles() {
  loadProjectList();
  const res = await fetch("/api/roles");
  const roles = await res.json();
  renderRoles(roles);
}

document.getElementById("org-browse-btn").addEventListener("click", async () => {
  const btn = document.getElementById("org-browse-btn");
  btn.disabled = true;
  btn.textContent = "選択中…";
  try {
    const res = await fetch("/api/browse-folder", { method: "POST" });
    const data = await res.json();
    if (data.path) document.getElementById("org-project-input").value = data.path;
  } catch {
    alert("フォルダ選択に失敗しました。");
  } finally {
    btn.disabled = false;
    btn.textContent = "📁 参照…";
  }
});

function renderRoles(roles) {
  const grid = document.getElementById("org-grid");
  grid.innerHTML = roles
    .map((r) => {
      const s = r.session;
      const status = s ? s.status : "off_duty";
      const label = s ? STATUS_LABEL[status] || status : "待機中(未起動)";
      const latestTurn = s?.turns?.length ? s.turns[s.turns.length - 1] : null;
      const isActive = s && ["running_tool", "thinking", "waiting_input", "compacting"].includes(status);
      return `
        <div class="role-card${isActive ? " is-active" : ""}" data-status="${escapeHtml(status)}">
          <div class="role-head">
            <span class="role-icon">${r.icon}</span>
            <span class="role-name">${escapeHtml(r.name)}</span>
            <span class="badge ${status}">${escapeHtml(label)}</span>
          </div>
          <div class="role-desc">${escapeHtml(r.description)}</div>
          ${
            latestTurn
              ? `<div class="role-current" data-tooltip="${escapeHtml(latestTurn.prompt || "")}">
                  ${latestTurn.prompt ? escapeHtml(latestTurn.prompt) : "(バックグラウンド継続作業)"}
                 </div>`
              : ""
          }
          <textarea class="role-instruction" placeholder="${escapeHtml(r.example || "この役割への指示を入力…")}" rows="2"></textarea>
          <button type="button" class="role-run-btn" data-role="${r.id}">▶ 起動する</button>
        </div>`;
    })
    .join("");

  grid.querySelectorAll(".role-run-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".role-card");
      const cwd = document.getElementById("org-project-input").value.trim();
      const instruction = card.querySelector(".role-instruction").value.trim();
      if (!cwd) { alert("対象プロジェクトのディレクトリを入力してください。"); return; }
      if (!instruction) { alert("指示内容を入力してください。"); return; }
      btn.disabled = true;
      btn.textContent = "起動中…";
      try {
        const res = await fetch(`/api/roles/${btn.dataset.role}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, instruction }),
        });
        btn.textContent = res.ok ? "✓ 起動しました" : "起動に失敗しました";
        if (res.ok) document.querySelector('.tab-btn[data-tab="agents"]').click();
      } catch {
        btn.textContent = "起動に失敗しました";
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = "▶ 起動する";
        }, 3000);
      }
    });
  });
}

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

// --- Tooltips ---
// Native `title` tooltips can't be styled (OS-rendered), and cards use
// overflow:hidden/auto for scrolling, which would clip a CSS-positioned
// tooltip anchored inside them. So this renders a single shared tooltip as
// a fixed-position element on <body>, positioned via getBoundingClientRect
// — outside any clipping ancestor. Delegated on <body> so it keeps working
// after renderGrid()/renderRoles() replace the DOM underneath it.
function initTooltips() {
  const tip = document.createElement("div");
  tip.className = "fv-tooltip";
  document.body.appendChild(tip);

  function place(el) {
    const r = el.getBoundingClientRect();
    tip.style.display = "block";
    const tipRect = tip.getBoundingClientRect();
    let top = r.top - tipRect.height - 8;
    if (top < 4) top = Math.min(r.bottom + 8, window.innerHeight - tipRect.height - 4);
    let left = Math.min(r.left, window.innerWidth - tipRect.width - 8);
    if (left < 4) left = 4;
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }

  // Hiding is delayed slightly so moving the mouse off the trigger and onto
  // the tooltip itself (to scroll a long one) doesn't dismiss it first.
  let hideTimer = null;
  function scheduleHide() {
    hideTimer = setTimeout(() => { tip.style.display = "none"; }, 200);
  }
  function cancelHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
  }

  document.body.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tooltip]");
    if (!el) return;
    cancelHide();
    const text = el.getAttribute("data-tooltip");
    if (!text) return;
    tip.textContent = text;
    place(el);
  });
  document.body.addEventListener("mouseout", (e) => {
    if (e.target.closest("[data-tooltip]") || e.target === tip) scheduleHide();
  });
  tip.addEventListener("mouseover", cancelHide);
  tip.addEventListener("mouseout", scheduleHide);
  document.body.addEventListener("scroll", (e) => {
    if (e.target === tip) return; // scrolling inside the tooltip itself shouldn't dismiss it
    tip.style.display = "none";
  }, true);
}

// --- Init ---
async function init() {
  const res = await fetch("/api/sessions");
  const list = await res.json();
  for (const s of list) sessions.set(s.id, s);
  renderGrid();
  connectWs();
  initTooltips();
  setInterval(renderGrid, 15000); // refresh relative timestamps
}

init();
