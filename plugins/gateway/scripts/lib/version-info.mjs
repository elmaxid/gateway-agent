import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Computes the version payload for a given plugin root. Pure aside from
 * reading plugin.json/build-info.json and spawning `git rev-parse HEAD` —
 * no logging, no process.exit, no config mutation.
 *
 * Resolution order for `commit`/`commitSource`:
 *   1. `git rev-parse HEAD` run with cwd=pluginRoot, when pluginRoot is
 *      inside a git work tree → "git". Dev checkouts must always report
 *      live HEAD — even when a committed build-info.json is sitting in the
 *      tree — otherwise editing code without re-running make-build-info.mjs
 *      would silently misreport provenance.
 *   2. <pluginRoot>/.claude-plugin/build-info.json (written by
 *      scripts/make-build-info.mjs and committed at release time) →
 *      "build-info". This serves git-less installs: marketplace clones
 *      land in ~/.claude/plugins/cache/... with no .git directory, so this
 *      is the only source of provenance they can carry.
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

  const gitResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  if (gitResult.status === 0 && gitResult.stdout && gitResult.stdout.trim()) {
    commit = gitResult.stdout.trim();
    commitSource = "git";
  }

  if (!commit) {
    const buildInfoPath = path.join(pluginRoot, ".claude-plugin", "build-info.json");
    try {
      const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
      if (buildInfo.commit) {
        commit = buildInfo.commit;
        commitSource = "build-info";
      }
    } catch {
      // No build-info.json (or unreadable/invalid) — fall through to unknown.
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
