// Explicitly saved "target project" shortcuts for the 組織図 dispatch panel —
// separate from store.js's listKnownProjects() (which just auto-derives cwds
// seen in session history). This is a small user-curated list: add once,
// pick from a dropdown thereafter instead of typing/browsing every time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const PROJECTS_FILE = path.join(DATA_DIR, "saved-projects.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function load() {
  if (!fs.existsSync(PROJECTS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function save(list) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2));
}

function listSavedProjects() {
  return load();
}

// Upsert by path: re-adding an existing path just renames it.
function addSavedProject(name, cwd) {
  const list = load();
  const existing = list.find((p) => p.path === cwd);
  if (existing) existing.name = name;
  else list.push({ name, path: cwd });
  save(list);
  return list;
}

function removeSavedProject(cwd) {
  const list = load().filter((p) => p.path !== cwd);
  save(list);
  return list;
}

export { listSavedProjects, addSavedProject, removeSavedProject };
