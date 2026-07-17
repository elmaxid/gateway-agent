import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Strip the git environment overrides that would let a caller's environment
 * redirect our provenance probes at a foreign repo. GIT_DIR / GIT_WORK_TREE /
 * GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR all override cwd-based
 * repo discovery, so a hostile or merely-inherited value would make us report
 * some other repo's HEAD.
 */
function sanitizedGitEnv() {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
    delete env[key];
  }
  return env;
}

/**
 * Computes the version payload for a given plugin root. Pure aside from
 * reading plugin.json/build-info.json and spawning git — no logging, no
 * process.exit, no config mutation.
 *
 * Resolution order for `commit`/`commitSource`:
 *   1. `git rev-parse HEAD` (cwd=pluginRoot, sanitized env, 5s timeout), but
 *      ONLY when this repo actually tracks the plugin — i.e. `git ls-files
 *      --error-unmatch .claude-plugin/plugin.json` exits 0 → "git". Dev
 *      checkouts must always report live HEAD, even when a committed
 *      build-info.json is sitting in the tree, otherwise editing code without
 *      re-running make-build-info.mjs would silently misreport provenance. The
 *      tracked-check keeps a git-less marketplace cache nested under an
 *      unrelated PARENT repo from borrowing that parent's HEAD (its plugin.json
 *      is untracked there), and the sanitized env keeps an inherited GIT_DIR
 *      from redirecting the probe at a foreign repo.
 *   2. <pluginRoot>/.claude-plugin/build-info.json (written by
 *      scripts/make-build-info.mjs and committed at release time) →
 *      "build-info". This serves git-less installs: marketplace clones
 *      land in ~/.claude/plugins/cache/... with no .git directory (or nested
 *      under a parent repo that doesn't track them), so this is the only
 *      source of provenance they can carry.
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

  const gitOpts = { cwd: pluginRoot, encoding: "utf8", env: sanitizedGitEnv(), timeout: 5000 };
  const gitResult = spawnSync("git", ["rev-parse", "HEAD"], gitOpts);
  if (gitResult.status === 0 && gitResult.stdout && gitResult.stdout.trim()) {
    // Trust HEAD only if THIS repo tracks the plugin — otherwise a marketplace
    // cache dropped inside an unrelated parent repo would report the parent's
    // HEAD instead of falling through to its committed build-info.json.
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", ".claude-plugin/plugin.json"], gitOpts);
    if (tracked.status === 0) {
      commit = gitResult.stdout.trim();
      commitSource = "git";
    }
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
