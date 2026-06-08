import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PERSONAS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../personas"
);

const _cache = new Map();
let _discovered = null;

function parseFrontmatter(raw, filename) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${filename}: missing or malformed frontmatter`);
  const meta = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    } else {
      meta[key] = val.replace(/^['"]|['"]$/g, "");
    }
  }
  if (!meta.name) throw new Error(`${filename}: frontmatter missing 'name'`);
  if (!Array.isArray(meta.activation_keywords) || meta.activation_keywords.length === 0) {
    throw new Error(`${filename}: frontmatter missing or empty 'activation_keywords'`);
  }
  return { meta, body: match[2].trim() };
}

const PRIORITY_ORDER = ["debugger", "reviewer", "security", "researcher", "coder"];

function loadAll() {
  let files;
  try {
    files = fs.readdirSync(PERSONAS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    process.stderr.write(`[personas] warning: personas dir not found: ${PERSONAS_DIR}\n`);
    _discovered = [];
    return;
  }
  const discovered = [];
  for (const filename of files.sort()) {
    const fullPath = path.join(PERSONAS_DIR, filename);
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const { meta, body } = parseFrontmatter(raw, filename);
      _cache.set(meta.name, { body, keywords: meta.activation_keywords });
      discovered.push(meta.name);
    } catch (err) {
      process.stderr.write(`[personas] warning: skipping ${filename}: ${err.message}\n`);
    }
  }
  _discovered = discovered.sort((a, b) => {
    const ai = PRIORITY_ORDER.indexOf(a);
    const bi = PRIORITY_ORDER.indexOf(b);
    return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
  });
}

export function getValidPersonas() {
  if (!_discovered) loadAll();
  return _discovered;
}

export function applyPersona(prompt, persona) {
  if (!persona) return prompt;
  if (!_discovered) loadAll();
  const entry = _cache.get(persona);
  if (!entry) {
    throw new Error(`Unknown persona "${persona}". Valid: ${_discovered.join(", ")}`);
  }
  return `${entry.body}\n\n---\n\n${prompt}`;
}

export function matchPersona(taskText) {
  if (!_discovered) loadAll();
  const lower = taskText.toLowerCase();
  for (const name of _discovered) {
    const entry = _cache.get(name);
    if (entry.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return name;
    }
  }
  return null;
}
