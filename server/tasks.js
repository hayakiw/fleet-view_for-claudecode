import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_FILE = path.join(__dirname, "..", "TASKS.md");

const DEFAULT_PREAMBLE = `# TASKS — FleetView 改善バックログ

自動開発エージェント向けのバックログです。上から順に、未完了(\`- [ ]\`)の項目を
**1件だけ**選んで実装・動作確認・コミットしてください。詳細なルールは
\`AGENT_INSTRUCTIONS.md\` を参照してください。

このファイルはダッシュボードの「タスク」タブからも編集できます。

---
`;

// Items are stored on disk as single-line `- [ ] text` / `- [x] text` bullets
// (any manual multi-line wrapping gets normalized away on the first GUI edit)
// so the file stays trivial to parse and rewrite without a markdown library.
function parseTasks() {
  if (!fs.existsSync(TASKS_FILE)) {
    fs.writeFileSync(TASKS_FILE, DEFAULT_PREAMBLE, "utf-8");
  }
  const raw = fs.readFileSync(TASKS_FILE, "utf-8");
  const lines = raw.split("\n");

  const preambleLines = [];
  const items = [];
  let inBody = false;
  let current = null;

  for (const line of lines) {
    const bullet = line.match(/^- \[( |x|X)\]\s?(.*)$/);
    if (bullet) {
      inBody = true;
      if (current) items.push(current);
      current = { done: bullet[1].toLowerCase() === "x", text: bullet[2].trim() };
      continue;
    }
    if (!inBody) {
      preambleLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed && current) {
      // Continuation of a wrapped multi-line item (old format) or a note.
      current.text += " " + trimmed;
    }
  }
  if (current) items.push(current);

  let preamble = preambleLines.join("\n").replace(/\n*$/, "\n");
  if (!preamble.trim()) preamble = DEFAULT_PREAMBLE;

  return { preamble, items };
}

function writeTasks(preamble, items) {
  const body = items
    .map((t) => `- [${t.done ? "x" : " "}] ${t.text}`)
    .join("\n\n");
  const content = preamble.replace(/\n*$/, "\n") + "\n" + body + "\n";
  fs.writeFileSync(TASKS_FILE, content, "utf-8");
}

function listTasks() {
  const { items } = parseTasks();
  return items.map((t, index) => ({ index, ...t }));
}

function addTask(text) {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("text is required");
  const { preamble, items } = parseTasks();
  items.push({ done: false, text: clean });
  writeTasks(preamble, items);
  return listTasks();
}

function setTaskDone(index, done) {
  const { preamble, items } = parseTasks();
  if (index < 0 || index >= items.length) throw new Error("task not found");
  items[index].done = !!done;
  // Strip/append a lightweight completion marker so manual GUI toggles match
  // the convention AGENT_INSTRUCTIONS.md asks the backlog agent to follow.
  items[index].text = items[index].text.replace(/\s*\(完了: [^)]*\)\s*$/, "");
  if (items[index].done) {
    const today = new Date().toISOString().slice(0, 10);
    items[index].text += ` (完了: ${today})`;
  }
  writeTasks(preamble, items);
  return listTasks();
}

function deleteTask(index) {
  const { preamble, items } = parseTasks();
  if (index < 0 || index >= items.length) throw new Error("task not found");
  items.splice(index, 1);
  writeTasks(preamble, items);
  return listTasks();
}

export { listTasks, addTask, setTaskDone, deleteTask };
