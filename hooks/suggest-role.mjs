#!/usr/bin/env node
// UserPromptSubmit hook: when a prompt is typed directly into a plain `claude`
// session (no --agent flag) and it matches one of the FleetView org chart's
// role keywords, this does two things:
//   1. Nudges Claude toward that persona's skill via additionalContext.
//   2. Tags THIS session with that role in FleetView, by posting a synthetic
//      event carrying agent_type — the same field store.js's ingest() uses
//      to associate a session with a role — so the org chart's card for that
//      role actually lights up (thinking/running/idle) in step with this
//      session's real activity, without spawning a separate duplicate agent.
//
// The tag uses a custom hook_event_name ("FleetViewRoleTag") that isn't in
// store.js's STATUS_BY_HOOK map, so it patches agentType without touching
// the session's status or re-pushing a duplicate prompt into its turn
// history (report-event.mjs already reported the real UserPromptSubmit event
// moments earlier in the same hook batch).
//
// Must never block or fail the hook: always exits 0, regardless of outcome.

import { classifyRole, getRole } from "../server/roles.js";

const PORT = process.env.FLEETVIEW_PORT || 4317;
const URL = `http://localhost:${PORT}/api/events`;
const TIMEOUT_MS = 1500;

// Mirrors store.js's isSystemInjectedPrompt — Claude Code injects system
// content (background task completions, reminders, tool output) through this
// same hook; those always start with an XML-ish tag and aren't things a human
// typed, so they shouldn't be classified.
const SYSTEM_PROMPT_RE = /^\s*<[a-zA-Z][\w-]*(\s|>)/;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function tagSession(event, roleId) {
  try {
    await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "FleetViewRoleTag",
        session_id: event.session_id,
        cwd: event.cwd,
        agent_type: roleId,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // FleetView server not running — the additionalContext hint still went
    // through, so just skip the dashboard tagging silently.
  }
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    process.exit(0);
  }
  if (!raw || !raw.trim()) process.exit(0);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const prompt = event.prompt;
  if (!prompt || typeof prompt !== "string" || SYSTEM_PROMPT_RE.test(prompt)) process.exit(0);

  // Already running under an explicit persona (org chart dispatch, or a
  // manual `claude --agent <role>`) — respect that choice, don't second-guess.
  if (event.agent_type) process.exit(0);

  const roleId = classifyRole(prompt);
  // "engineer" is classifyRole's catch-all for anything that didn't match a
  // specific keyword — tagging/suggesting it for every ordinary prompt would
  // just be noise, so only act when a real keyword match fired.
  if (roleId === "engineer") process.exit(0);

  const role = getRole(roleId);
  if (!role) process.exit(0);

  await tagSession(event, roleId);

  const context =
    `[FleetView 組織図ヒント] この指示は組織図の「${role.name}」ロール` +
    `（${role.description}）に近い内容です。対応する場合は \`${role.skill}\` スキルの` +
    `観点も参考にしてください（参考情報であり必須ではありません）。このセッションは` +
    `組織図にも「${role.name}」として反映されます。`;

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context,
      },
    })
  );
  process.exit(0);
}

main();
