import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEventsSince, listActiveSessions, isSystemInjectedPrompt } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(__dirname, "..", "reports");
fs.mkdirSync(REPORTS_DIR, { recursive: true });

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}分`;
  return `${Math.floor(min / 60)}時間${min % 60}分`;
}

function projectName(cwd) {
  if (!cwd) return "不明";
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

/**
 * Build a markdown activity report covering the last `periodMs` milliseconds.
 * Grouped by project (not raw session id) and centered on what a human actually
 * asked for, so the report reads as "what happened on each project" rather than
 * a bare tool-call tally.
 */
function buildReport(periodMs) {
  const now = Date.now();
  const since = now - periodMs;
  const events = readEventsSince(since);

  const byProject = new Map();
  for (const ev of events) {
    const cwd = ev.cwd ?? "unknown";
    const proj = projectName(cwd);
    if (!byProject.has(proj)) {
      byProject.set(proj, { cwd, sessionIds: new Set(), toolCounts: {}, prompts: [] });
    }
    const p = byProject.get(proj);
    p.sessionIds.add(ev.session_id);
    if (ev.hook_event_name === "PreToolUse" && ev.tool_name) {
      p.toolCounts[ev.tool_name] = (p.toolCounts[ev.tool_name] ?? 0) + 1;
    }
    if (ev.hook_event_name === "UserPromptSubmit" && ev.prompt && !isSystemInjectedPrompt(ev.prompt)) {
      const text = (ev.prompt.length > 200 ? ev.prompt.slice(0, 200) + "…" : ev.prompt).replace(/\s+/g, " ").trim();
      if (text && p.prompts[p.prompts.length - 1] !== text) p.prompts.push(text);
    }
  }

  const totalTools = events.filter((e) => e.hook_event_name === "PreToolUse").length;
  const totalPrompts = events.filter(
    (e) => e.hook_event_name === "UserPromptSubmit" && e.prompt && !isSystemInjectedPrompt(e.prompt)
  ).length;
  const activeNow = listActiveSessions();

  const projectNames = Array.from(byProject.keys());
  const title =
    projectNames.length === 0
      ? "FleetView 活動レポート（対象期間内の活動なし）"
      : projectNames.length <= 3
      ? `FleetView 活動レポート — ${projectNames.join("・")}`
      : `FleetView 活動レポート — ${projectNames.slice(0, 3).join("・")} 他${projectNames.length - 3}件`;

  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`生成日時: ${new Date(now).toLocaleString("ja-JP")}`);
  lines.push(`対象期間: 過去 ${fmtDuration(periodMs)}`);
  lines.push("");
  lines.push(`## サマリー`);
  lines.push(`- 対象プロジェクト数: ${byProject.size}`);
  lines.push(`- 現在アクティブなセッション数: ${activeNow.length}`);
  lines.push(`- 実行されたツール呼び出し数: ${totalTools}`);
  lines.push(`- 人からの指示数: ${totalPrompts}`);
  lines.push("");
  lines.push(`## プロジェクト別の内容`);
  if (byProject.size === 0) {
    lines.push("(対象期間内にイベントはありませんでした)");
  }
  for (const [proj, p] of byProject) {
    lines.push("");
    lines.push(`### ${proj}`);
    lines.push(`\`${p.cwd}\``);
    lines.push("");
    if (p.prompts.length > 0) {
      lines.push(`**指示された内容:**`);
      for (const prompt of p.prompts) lines.push(`- ${prompt}`);
    } else {
      lines.push(`**指示された内容:** (この期間、新しい人からの指示はありませんでした。バックグラウンドでの継続作業のみです)`);
    }
    lines.push("");
    const toolSummary = Object.entries(p.toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([tool, n]) => `${tool}×${n}`)
      .join(", ");
    lines.push(`ツール使用: ${toolSummary || "なし"} ／ セッション数: ${p.sessionIds.size}`);
  }

  return { markdown: lines.join("\n"), title };
}

function generateAndSave(periodMs) {
  const { markdown, title } = buildReport(periodMs);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `report-${ts}.md`;
  fs.writeFileSync(path.join(REPORTS_DIR, filename), markdown, "utf-8");
  return { filename, markdown, title };
}

function extractTitle(markdown) {
  const firstLine = markdown.split("\n", 1)[0] ?? "";
  return firstLine.replace(/^#\s*/, "") || "(無題のレポート)";
}

function listReports() {
  return fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .map((filename) => {
      let title = filename;
      try {
        const fd = fs.openSync(path.join(REPORTS_DIR, filename), "r");
        const buf = Buffer.alloc(4096);
        const bytes = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        title = extractTitle(buf.slice(0, bytes).toString("utf-8"));
      } catch {
        // fall back to filename
      }
      return { filename, title };
    });
}

function readReport(filename) {
  const safe = path.basename(filename);
  const p = path.join(REPORTS_DIR, safe);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8");
}

export { buildReport, generateAndSave, listReports, readReport };
