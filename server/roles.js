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
  },
  {
    id: "engineer",
    name: "エンジニア",
    icon: "🛠️",
    description: "実装・修正・コミットを担当",
  },
  {
    id: "reviewer",
    name: "レビュアー",
    icon: "🔍",
    description: "コードレビューを担当。実装はしない",
  },
];

function listRoles() {
  return ROLES;
}

function getRole(id) {
  return ROLES.find((r) => r.id === id) ?? null;
}

export { listRoles, getRole };
