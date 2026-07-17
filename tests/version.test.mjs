/**
 * Task A5 — `version --json` with build provenance + kind-incompatibility
 * warning (plan §5.2, §13.1).
 *
 * Covers:
 *   1. getVersionInfo() reads commit from build-info.json when present.
 *   2. getVersionInfo() falls back to `git rev-parse HEAD` when no
 *      build-info.json exists but pluginRoot is a git checkout.
 *   3. getVersionInfo() reports "unknown" when neither is available.
 *   3b. executeVersion() (the CLI-facing wrapper) logs a stderr warning in
 *       that "unknown" case, without throwing.
 *   4. scripts/make-build-info.mjs writes a valid build-info.json (40-char
 *      hex commit + ISO builtAt), and fails loud outside a git checkout.
 *   5. `setup add` / `setup set-default` warn on stderr when the resulting
 *      defaultProfile/taskProfile is kind "openai-chat" (rejected by
 *      task/dispatch) — and stay silent for kind "claude-gateway".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { getVersionInfo } from "../plugins/gateway/scripts/lib/version-info.mjs";
import { executeVersion } from "../plugins/gateway/scripts/gateway-companion.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const COMPANION = path.join(REPO_ROOT, "plugins/gateway/scripts/gateway-companion.mjs");
const MAKE_BUILD_INFO = path.join(REPO_ROOT, "scripts/make-build-info.mjs");
const REAL_PLUGIN_ROOT = path.join(REPO_ROOT, "plugins/gateway");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePluginJson(pluginRoot, version) {
  const dir = path.join(pluginRoot, ".claude-plugin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "gateway", version }));
  return dir;
}

async function runCli(args, tmpDir) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [COMPANION, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: tmpDir },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// ---------------------------------------------------------------------------
// 1. build-info.json present
// ---------------------------------------------------------------------------

describe("getVersionInfo — build-info.json present", () => {
  it("reads commit + source from build-info.json, pluginVersion from plugin.json", () => {
    const tmp = mkTmp("gw-version-buildinfo-");
    try {
      const pluginDir = writePluginJson(tmp, "9.9.9");
      const fakeCommit = "a".repeat(40);
      fs.writeFileSync(
        path.join(pluginDir, "build-info.json"),
        JSON.stringify({ commit: fakeCommit, builtAt: new Date().toISOString() })
      );

      const info = getVersionInfo({ pluginRoot: tmp });
      assert.equal(info.pluginVersion, "9.9.9");
      assert.equal(info.commit, fakeCommit);
      assert.equal(info.commitSource, "build-info");
      assert.equal(info.pluginRoot, tmp);
      assert.equal(info.node, process.version);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. no build-info.json, real git checkout
// ---------------------------------------------------------------------------

describe("getVersionInfo — real plugin root (dev checkout: git wins even over a committed build-info.json)", () => {
  it("resolves commit via git rev-parse HEAD, not build-info.json, since this is a live git work tree", () => {
    // Uses the real plugins/gateway dir in THIS repo, which is always inside
    // a git work tree when the suite runs from a checkout. Under the
    // git-first precedence, commitSource must be "git" unconditionally here
    // — even if a committed build-info.json happens to exist alongside it
    // (release flow commits one at tag time) — because dev checkouts must
    // always report live HEAD, not a possibly-stale committed snapshot.
    const expected = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REAL_PLUGIN_ROOT, encoding: "utf8" });
    assert.equal(expected.status, 0, "precondition: repo must be a git checkout with a HEAD commit");

    const info = getVersionInfo({ pluginRoot: REAL_PLUGIN_ROOT });
    assert.equal(info.commitSource, "git", "git must win in a live work tree regardless of build-info.json");
    assert.equal(info.commit, expected.stdout.trim());
    assert.match(info.commit, /^[0-9a-f]{40}$/);

    const pluginJson = JSON.parse(
      fs.readFileSync(path.join(REAL_PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    );
    assert.equal(info.pluginVersion, pluginJson.version, "must read version dynamically, not hardcode it");
  });
});

// ---------------------------------------------------------------------------
// 2b. both .git and build-info.json present — git must win (proves precedence,
// not mere consistency: build-info.json is planted with a DIFFERENT commit)
// ---------------------------------------------------------------------------

describe("getVersionInfo — both .git and build-info.json present", () => {
  it("reports commitSource 'git' and the live HEAD commit, ignoring a stale build-info.json", () => {
    const tmp = mkTmp("gw-version-both-");
    try {
      writePluginJson(tmp, "5.5.5");
      const initResult = spawnSync("git", ["init", "-q"], { cwd: tmp });
      assert.equal(initResult.status, 0, "precondition: git init must succeed");
      // Track plugin.json so the tracked-check trusts this repo's HEAD — git is
      // trusted only for a repo that actually tracks the plugin.
      const addResult = spawnSync("git", ["add", ".claude-plugin/plugin.json"], { cwd: tmp });
      assert.equal(addResult.status, 0, "precondition: git add must succeed");
      const commitResult = spawnSync(
        "git",
        ["-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "-q", "-m", "init"],
        { cwd: tmp }
      );
      assert.equal(commitResult.status, 0, "precondition: commit must succeed");
      const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" });
      assert.equal(gitHead.status, 0);
      const realCommit = gitHead.stdout.trim();

      // Fake commit deliberately differs from realCommit, so a pass proves
      // git precedence rather than coincidental agreement. build-info.json is
      // left UNTRACKED — the tracked-check only requires plugin.json to be
      // tracked, which is what marks this as a genuine checkout of the plugin.
      const fakeCommit = "f".repeat(40);
      fs.writeFileSync(
        path.join(tmp, ".claude-plugin", "build-info.json"),
        JSON.stringify({ commit: fakeCommit, builtAt: new Date().toISOString() })
      );

      const info = getVersionInfo({ pluginRoot: tmp });
      assert.equal(info.commitSource, "git");
      assert.equal(info.commit, realCommit);
      assert.notEqual(info.commit, fakeCommit);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2c. pluginRoot is an UNTRACKED subdir nested inside a parent git repo, with a
// committed build-info.json. git-first must NOT report the parent's HEAD; the
// tracked-check falls through to build-info — this is the marketplace-cache-
// dropped-inside-a-parent-repo case.
// ---------------------------------------------------------------------------

describe("getVersionInfo — untracked plugin nested inside a parent git repo", () => {
  it("ignores the parent's HEAD (plugin.json untracked) and uses build-info", () => {
    const parent = mkTmp("gw-version-parent-");
    try {
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: parent }).status, 0, "precondition: parent git init");
      assert.equal(
        spawnSync("git", ["-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "parent"], { cwd: parent }).status,
        0,
        "precondition: parent commit"
      );
      const parentHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: parent, encoding: "utf8" }).stdout.trim();

      // Nested plugin root — files deliberately NOT `git add`ed (a marketplace
      // cache clone dropped inside someone's repo).
      const pluginRoot = path.join(parent, "cache", "gateway");
      const pluginDir = writePluginJson(pluginRoot, "3.3.3");
      const buildCommit = "c".repeat(40);
      fs.writeFileSync(
        path.join(pluginDir, "build-info.json"),
        JSON.stringify({ commit: buildCommit, builtAt: new Date().toISOString() })
      );

      const info = getVersionInfo({ pluginRoot });
      assert.equal(info.commitSource, "build-info", "must not trust the parent repo's HEAD for an untracked plugin");
      assert.equal(info.commit, buildCommit);
      assert.notEqual(info.commit, parentHead);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2d. A hostile/inherited GIT_DIR in the environment must not redirect
// provenance away from the plugin's own checkout — the git child runs with a
// sanitized env.
// ---------------------------------------------------------------------------

describe("getVersionInfo — hostile GIT_DIR env is ignored", () => {
  it("reports the checkout's own HEAD even when GIT_DIR points at another repo", () => {
    const other = mkTmp("gw-version-othergit-");
    const savedGitDir = process.env.GIT_DIR;
    try {
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: other }).status, 0, "precondition: other git init");
      assert.equal(
        spawnSync("git", ["-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "other"], { cwd: other }).status,
        0,
        "precondition: other commit"
      );
      const otherHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: other, encoding: "utf8" }).stdout.trim();

      const realHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REAL_PLUGIN_ROOT, encoding: "utf8" }).stdout.trim();
      assert.match(realHead, /^[0-9a-f]{40}$/);
      assert.notEqual(realHead, otherHead, "precondition: the two repos have different HEADs");

      process.env.GIT_DIR = path.join(other, ".git");
      const info = getVersionInfo({ pluginRoot: REAL_PLUGIN_ROOT });
      assert.equal(info.commitSource, "git");
      assert.equal(info.commit, realHead, "GIT_DIR must be stripped from the git child's env");
      assert.notEqual(info.commit, otherHead);
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedGitDir;
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. no build-info.json, no git
// ---------------------------------------------------------------------------

describe("getVersionInfo — no build-info.json, no git", () => {
  it("returns commit 'unknown', commitSource 'unknown'", () => {
    const tmp = mkTmp("gw-version-nogit-");
    try {
      writePluginJson(tmp, "1.2.3");
      const info = getVersionInfo({ pluginRoot: tmp });
      assert.equal(info.pluginVersion, "1.2.3");
      assert.equal(info.commit, "unknown");
      assert.equal(info.commitSource, "unknown");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("executeVersion — stderr warning on unknown commit", () => {
  it("logs a stderr warning and still returns a payload (exit 0 path, no throw)", () => {
    const tmp = mkTmp("gw-version-warn-");
    try {
      writePluginJson(tmp, "0.0.0");

      const originalError = console.error;
      const captured = [];
      console.error = (...args) => captured.push(args.join(" "));
      let info;
      try {
        info = executeVersion({ pluginRoot: tmp });
      } finally {
        console.error = originalError;
      }

      assert.equal(info.commitSource, "unknown");
      assert.equal(info.commit, "unknown");
      assert.ok(
        captured.some((line) => /unknown/i.test(line)),
        `expected a stderr warning mentioning the unknown commit, got: ${JSON.stringify(captured)}`
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does NOT warn when commitSource is resolved (git or build-info)", () => {
    const originalError = console.error;
    const captured = [];
    console.error = (...args) => captured.push(args.join(" "));
    let info;
    try {
      info = executeVersion({ pluginRoot: REAL_PLUGIN_ROOT });
    } finally {
      console.error = originalError;
    }
    assert.ok(
      ["git", "build-info"].includes(info.commitSource),
      `expected a resolved commitSource, got ${info.commitSource}`
    );
    assert.equal(captured.length, 0, `expected no stderr warning, got: ${JSON.stringify(captured)}`);
  });
});

// ---------------------------------------------------------------------------
// 4. scripts/make-build-info.mjs
// ---------------------------------------------------------------------------

describe("scripts/make-build-info.mjs", () => {
  it("writes a valid build-info.json (40-char hex commit, ISO builtAt)", async () => {
    const tmp = mkTmp("gw-make-build-info-");
    try {
      spawnSync("git", ["init", "-q"], { cwd: tmp });
      const commitResult = spawnSync(
        "git",
        ["-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "init"],
        { cwd: tmp }
      );
      assert.equal(commitResult.status, 0, "precondition: empty commit must succeed");
      const expected = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" });
      assert.equal(expected.status, 0);

      const before = Date.now();
      const { stdout } = await execFileAsync(process.execPath, [MAKE_BUILD_INFO], { cwd: tmp });
      const after = Date.now();

      assert.match(stdout, /Wrote/);

      const outPath = path.join(tmp, "plugins", "gateway", ".claude-plugin", "build-info.json");
      const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
      assert.equal(written.commit, expected.stdout.trim());
      assert.match(written.commit, /^[0-9a-f]{40}$/);

      const builtAtMs = Date.parse(written.builtAt);
      assert.ok(Number.isFinite(builtAtMs), "builtAt must parse as a valid date");
      assert.equal(new Date(builtAtMs).toISOString(), written.builtAt, "builtAt must be ISO 8601");
      assert.ok(
        builtAtMs >= before - 1000 && builtAtMs <= after + 1000,
        "builtAt must be close to the time the script ran"
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails loud (non-zero exit, stderr message) outside a git checkout", async () => {
    const tmp = mkTmp("gw-make-build-info-nogit-");
    try {
      await assert.rejects(execFileAsync(process.execPath, [MAKE_BUILD_INFO], { cwd: tmp }), (err) => {
        assert.notEqual(err.code, 0);
        assert.match(err.stderr, /make-build-info/);
        return true;
      });
      const outPath = path.join(tmp, "plugins", "gateway", ".claude-plugin", "build-info.json");
      assert.ok(!fs.existsSync(outPath), "must not write build-info.json on failure");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. setup add / setup set-default — kind-incompatibility warning
// ---------------------------------------------------------------------------

describe("setup warning — kind-incompatible defaultProfile/taskProfile", () => {
  it("setup add with kind openai-chat becoming defaultProfile emits the warning", async () => {
    const tmp = mkTmp("gw-setup-warn-add-");
    try {
      const result = await runCli(
        ["setup", "add", "--profile", "oai1", "--url", "https://api.example.com", "--model", "gpt-4o", "--kind", "openai-chat"],
        tmp
      );
      assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
      assert.match(result.stderr, /Warning:.*"oai1".*openai-chat.*rejected by task\/dispatch/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("setup add with kind claude-gateway does NOT emit the warning", async () => {
    const tmp = mkTmp("gw-setup-warn-add-ok-");
    try {
      const result = await runCli(
        ["setup", "add", "--profile", "cg1", "--url", "https://api.example.com", "--model", "claude-x", "--kind", "claude-gateway"],
        tmp
      );
      assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
      assert.ok(!/openai-chat/.test(result.stderr), `unexpected openai-chat warning in stderr: ${result.stderr}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("setup set-default onto an openai-chat profile emits the warning", async () => {
    const tmp = mkTmp("gw-setup-warn-setdefault-");
    try {
      await runCli(
        ["setup", "add", "--profile", "cg2", "--url", "https://api.example.com", "--model", "claude-x", "--kind", "claude-gateway"],
        tmp
      );
      await runCli(
        ["setup", "add", "--profile", "oai2", "--url", "https://api.example.com", "--model", "gpt-4o", "--kind", "openai-chat"],
        tmp
      );
      const result = await runCli(["setup", "set-default", "--profile", "oai2"], tmp);
      assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
      assert.match(result.stderr, /Warning:.*"oai2".*openai-chat.*rejected by task\/dispatch/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("setup set-default onto a claude-gateway profile does NOT emit the warning", async () => {
    const tmp = mkTmp("gw-setup-warn-setdefault-ok-");
    try {
      await runCli(
        ["setup", "add", "--profile", "cg3", "--url", "https://api.example.com", "--model", "claude-x", "--kind", "claude-gateway"],
        tmp
      );
      await runCli(
        ["setup", "add", "--profile", "cg4", "--url", "https://api.example.com", "--model", "claude-y", "--kind", "claude-gateway"],
        tmp
      );
      const result = await runCli(["setup", "set-default", "--profile", "cg4"], tmp);
      assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
      assert.ok(!/openai-chat/.test(result.stderr), `unexpected openai-chat warning in stderr: ${result.stderr}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("setup set-task-profile onto an openai-chat profile emits the warning", async () => {
    const tmp = mkTmp("gw-setup-warn-settask-");
    try {
      await runCli(
        ["setup", "add", "--profile", "cg5", "--url", "https://api.example.com", "--model", "claude-x", "--kind", "claude-gateway"],
        tmp
      );
      await runCli(
        ["setup", "add", "--profile", "oai3", "--url", "https://api.example.com", "--model", "gpt-4o", "--kind", "openai-chat"],
        tmp
      );
      const result = await runCli(["setup", "set-task-profile", "--profile", "oai3"], tmp);
      assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
      assert.match(result.stderr, /Warning:.*"oai3".*openai-chat.*rejected by task\/dispatch/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("setup set-task-profile onto a claude-gateway profile does NOT emit the warning", async () => {
    const tmp = mkTmp("gw-setup-warn-settask-ok-");
    try {
      await runCli(
        ["setup", "add", "--profile", "cg6", "--url", "https://api.example.com", "--model", "claude-x", "--kind", "claude-gateway"],
        tmp
      );
      await runCli(
        ["setup", "add", "--profile", "cg7", "--url", "https://api.example.com", "--model", "claude-y", "--kind", "claude-gateway"],
        tmp
      );
      const result = await runCli(["setup", "set-task-profile", "--profile", "cg7"], tmp);
      assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
      assert.ok(!/openai-chat/.test(result.stderr), `unexpected openai-chat warning in stderr: ${result.stderr}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI smoke test — `version` / `version --json` end to end
// ---------------------------------------------------------------------------

describe("gateway-companion version (CLI)", () => {
  it("version --json returns the documented schema against the real plugin", async () => {
    const tmp = mkTmp("gw-version-cli-");
    try {
      const result = await runCli(["version", "--json"], tmp);
      assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      const pluginJson = JSON.parse(
        fs.readFileSync(path.join(REAL_PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
      );
      assert.equal(payload.pluginVersion, pluginJson.version);
      assert.match(payload.commit, /^[0-9a-f]{40}$/);
      assert.ok(
        ["git", "build-info"].includes(payload.commitSource),
        `expected commitSource git|build-info, got ${payload.commitSource}`
      );
      assert.equal(payload.pluginRoot, REAL_PLUGIN_ROOT);
      assert.equal(payload.node, process.version);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("version (no --json) renders readable lines with the same fields", async () => {
    const tmp = mkTmp("gw-version-cli-plain-");
    try {
      const result = await runCli(["version"], tmp);
      assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
      assert.match(result.stdout, /pluginVersion:/);
      assert.match(result.stdout, /commit:/);
      assert.match(result.stdout, /commitSource:/);
      assert.match(result.stdout, /pluginRoot:/);
      assert.match(result.stdout, /node:/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is listed in printUsage/help output", async () => {
    const tmp = mkTmp("gw-version-cli-help-");
    try {
      const result = await runCli(["help"], tmp);
      assert.match(result.stdout, /gateway-companion version/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
