import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Computes the version payload for a given plugin root. Pure aside from
 * reading plugin.json/build-info.json and spawning `git rev-parse HEAD` —
 * no logging, no process.exit, no config mutation.
 *
 * Resolution order for `commit`/`commitSource`:
 *   1. <pluginRoot>/.claude-plugin/build-info.json (written by
 *      scripts/make-build-info.mjs at release time) → "build-info"
 *   2. `git rev-parse HEAD` run with cwd=pluginRoot (dev checkouts) → "git"
 *   3. Neither available → commit "unknown", commitSource "unknown"
 */
export function getVersionInfo({ pluginRoot }) {
  const pluginJsonPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  let pluginVersion = "unknown";
  try {
    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
    if (pluginJson.version) pluginVersion = pluginJson.version;
  } catch {
    // pluginVersion stays "unknown" — missing/unreadable/invalid plugin.json.
  }

  let commit = null;
  let commitSource = null;

  const buildInfoPath = path.join(pluginRoot, ".claude-plugin", "build-info.json");
  try {
    const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
    if (buildInfo.commit) {
      commit = buildInfo.commit;
      commitSource = "build-info";
    }
  } catch {
    // No build-info.json (or unreadable/invalid) — fall through to git.
  }

  if (!commit) {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: pluginRoot,
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout && result.stdout.trim()) {
      commit = result.stdout.trim();
      commitSource = "git";
    }
  }

  if (!commit) {
    commit = "unknown";
    commitSource = "unknown";
  }

  return {
    pluginVersion,
    commit,
    commitSource,
    pluginRoot,
    node: process.version,
  };
}
