#!/usr/bin/env node
// Writes plugins/gateway/.claude-plugin/build-info.json with the current git
// commit + build timestamp, so `gateway-companion version --json` can report
// exactly which build a checkout is running instead of relying on the plugin
// version string alone (which can lag behind actual fixes — see v0.5.1).
//
// Run from the repo root (matches package.json's "build-info" script):
//   node scripts/make-build-info.mjs
//
// Fails loud (non-zero exit + message) if git isn't available or this isn't
// a git checkout — a build-info.json with a fabricated/missing commit would
// be worse than none, since it would misreport provenance.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const OUT_DIR = path.join(REPO_ROOT, "plugins", "gateway", ".claude-plugin");
const OUT_PATH = path.join(OUT_DIR, "build-info.json");

const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
if (result.error || result.status !== 0 || !result.stdout || !result.stdout.trim()) {
  const detail = result.error
    ? result.error.message
    : (result.stderr || "").trim() || `git exited ${result.status}`;
  console.error(`[make-build-info] Failed to resolve git commit (cwd: ${REPO_ROOT}): ${detail}`);
  console.error("[make-build-info] Run this from a git checkout with at least one commit.");
  process.exit(1);
}

const commit = result.stdout.trim();
const builtAt = new Date().toISOString();

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify({ commit, builtAt }, null, 2) + "\n");

console.log(`[make-build-info] Wrote ${OUT_PATH} (commit ${commit.slice(0, 7)}, builtAt ${builtAt})`);
