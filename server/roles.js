// Each role maps to a custom agent persona defined at ~/.claude/agents/<id>.md
// (user-level, not project-local) — so the same "engineer"/"reviewer"/
// "architect" personas work when dispatched against ANY project directory,
// not just this one. This registry only holds display metadata; what they
// actually do each time comes from the free-text instruction the dashboard
// sends at dispatch time (POST /api/roles/:id/run), not a fixed prompt here.
const ROLES = [
  {
    id: "architect",
    name: "アーキテクト",
    icon: "🧭",
    description: "設計・計画を担当。実装はしない",
    example: "ログイン画面に2段階認証を追加したい。既存の認証まわりの構成を踏まえた設計案をまとめてください",
  },
  {
    id: "engineer",
    name: "エンジニア",
    icon: "🛠️",
    description: "実装・修正・コミットを担当",
    example: "一覧画面のページネーションが2ページ目以降で件数がずれるバグを直してください",
  },
  {
    id: "reviewer",
    name: "レビュアー",
    icon: "🔍",
    description: "コードレビューを担当。実装はしない",
    example: "直近のコミットをレビューして、バグやセキュリティ上の懸念があれば指摘してください",
  },
];

function listRoles() {
  return ROLES;
}

function getRole(id) {
  return ROLES.find((r) => r.id === id) ?? null;
}

export { listRoles, getRole };
