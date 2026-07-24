// Each role maps to a custom agent persona. The canonical, git-tracked
// source lives in this repo at .claude/agents/<id>.md (+ paired skills in
// .claude/skills/), but Claude Code only resolves an agent against the
// *target* project's cwd — so `npm run sync-agents` copies these to
// ~/.claude/ (user-level), which is what actually lets the same personas
// be dispatched against ANY project directory, not just this one. This
// registry only holds display metadata; what a role actually does each
// time comes from the free-text instruction sent at dispatch time.
// Order matters here: the org chart groups roles by `team` in first-seen
// order, so listing 営業 before 開発 is what puts 営業 on the left.
const ROLES = [
  {
    id: "researcher",
    name: "リサーチャー",
    icon: "🌐",
    description: "Web調査・情報収集を行い、根拠となる調査メモをまとめる担当",
    team: "営業",
  },
  {
    id: "presenter",
    name: "プレゼンター",
    icon: "📊",
    description: "調査結果をもとにスライド資料を作成する担当",
    team: "営業",
  },
  {
    id: "minutes",
    name: "議事録",
    icon: "📋",
    description: "メモ書きから議事録を作成する担当",
    team: "営業",
  },
  {
    id: "architect",
    name: "アーキテクト",
    icon: "🧭",
    description: "設計・計画を担当",
    team: "開発",
  },
  {
    id: "engineer",
    name: "エンジニア",
    icon: "🛠️",
    description: "実装・修正・コミットを担当",
    team: "開発",
  },
  {
    id: "reviewer",
    name: "レビュアー",
    icon: "🔍",
    description: "コードレビューを担当",
    team: "開発",
  },
  {
    id: "feature-proposal",
    name: "機能提案",
    icon: "💡",
    description: "プロダクトをより便利にする新機能を提案する担当",
    team: "開発",
  },
  {
    id: "lp-designer",
    name: "LP",
    icon: "🎨",
    description: "LP（ランディングページ）のデザイン・実装を担当。HTML/CSSで作成する",
    team: "デザイン",
  },
  {
    id: "system-designer",
    name: "システム",
    icon: "🖥️",
    description: "プロダクト・システム画面のデザイン・実装を担当。HTML/CSSで作成する",
    team: "デザイン",
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
  reviewer: ["レビュー", "確認して", "チェックして", "問題ないか", "監査", "diffを見て", "指摘", "セキュリティ", "脆弱性"],
  presenter: ["スライド", "プレゼン", "発表資料"],
  researcher: ["情報収集", "調査して", "リサーチ", "調べて"],
  minutes: ["議事録", "メモ書きから"],
  "lp-designer": ["LP", "ランディングページ"],
  "system-designer": ["デザイン", "UI", "ダッシュボード"],
  // Checked before architect so "機能提案して" doesn't fall through to
  // architect's generic "提案" keyword.
  "feature-proposal": ["機能提案", "便利になる機能", "新機能のアイデア", "追加機能を提案"],
  architect: ["設計", "計画", "プラン", "検討", "提案", "方針", "どう実装すべき"],
};

function classifyRole(instruction) {
  for (const [roleId, keywords] of Object.entries(ROUTING_KEYWORDS)) {
    if (keywords.some((k) => instruction.includes(k))) return roleId;
  }
  return "engineer"; // default: most instructions are "do/fix this"
}

export { listRoles, getRole, classifyRole };
