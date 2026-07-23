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

// Keyword-based routing so the user writes one instruction and the right
// persona (and its tool restrictions — reviewer/architect can't Write) gets
// picked automatically, instead of making them choose a role up front.
// Checked in order: review-ish wording wins over design-ish wording over
// the engineer default, since "レビューして直して" should still route to
// reviewer (report, don't silently fix).
const ROUTING_KEYWORDS = {
  reviewer: ["レビュー", "確認して", "チェックして", "問題ないか", "監査", "diffを見て", "指摘"],
  architect: ["設計", "計画", "プラン", "検討", "提案", "方針", "どう実装すべき"],
};

function classifyRole(instruction) {
  for (const [roleId, keywords] of Object.entries(ROUTING_KEYWORDS)) {
    if (keywords.some((k) => instruction.includes(k))) return roleId;
  }
  return "engineer"; // default: most instructions are "do/fix this"
}

export { listRoles, getRole, classifyRole };
