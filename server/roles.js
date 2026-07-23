import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");

// Each role maps to a custom agent defined in .claude/agents/<id>.md, which
// carries the actual behavior/tool-access rules. This registry only holds
// the dispatch prompt and display metadata for the dashboard's org-chart tab.
const ROLES = [
  {
    id: "architect",
    name: "アーキテクト",
    icon: "🧭",
    description: "コードベースを見て、次に着手すべき改善をバックログに追加する（実装はしない）",
    prompt:
      `${PROJECT_ROOT} ディレクトリのコードベースと README.md、TASKS.md を確認し、` +
      `まだ手薄な部分や改善点を1つ見つけて TASKS.md の末尾に新しい未完了項目として追記してください。実装はしないでください。`,
  },
  {
    id: "engineer",
    name: "エンジニア",
    icon: "🛠️",
    description: "TASKS.md のバックログを1件選んで実装・動作確認・コミットする",
    prompt:
      `${PROJECT_ROOT} ディレクトリで AGENT_INSTRUCTIONS.md の指示に従い、` +
      `TASKS.md のバックログを1件消化してください。`,
  },
  {
    id: "reviewer",
    name: "レビュアー",
    icon: "🔍",
    description: "直近のコミットをレビューし、問題があればバックログに追記する（実装はしない）",
    prompt:
      `${PROJECT_ROOT} ディレクトリで直近のgitコミットをレビューしてください。` +
      `バグやセキュリティ上の懸念があれば TASKS.md の末尾に新しい未完了項目として追記してください。実装はしないでください。`,
  },
];

function listRoles() {
  return ROLES.map(({ id, name, icon, description }) => ({ id, name, icon, description }));
}

function getRole(id) {
  return ROLES.find((r) => r.id === id) ?? null;
}

export { listRoles, getRole };
