#!/usr/bin/env node
// Copies this project's .claude/agents and .claude/skills into the user-level
// ~/.claude/ directories.
//
// Why this exists: Claude Code only resolves a custom agent's persona
// (~/.claude/agents/<id>.md) and skills against the *target* project's cwd,
// not the FleetView repo's — verified experimentally: dispatching --agent
// engineer against a different project prints "warning: no agent named
// 'engineer'" unless the persona lives at the user level. So the canonical,
// git-tracked copies live in this repo (shareable, versioned), and this
// script installs them to where Claude Code actually looks them up.
//
// Run after cloning, and again after editing anything under .claude/.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");
const HOME = os.homedir();

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
      console.log(`  ${path.relative(PROJECT_ROOT, s)} -> ${d}`);
    }
  }
}

console.log("Syncing agent personas...");
copyDir(path.join(PROJECT_ROOT, ".claude", "agents"), path.join(HOME, ".claude", "agents"));

console.log("Syncing skills...");
copyDir(path.join(PROJECT_ROOT, ".claude", "skills"), path.join(HOME, ".claude", "skills"));

console.log("Done.");
