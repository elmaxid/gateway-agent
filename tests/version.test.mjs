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

describe("getVersionInfo — no build-info.json, git checkout", () => {
  it("falls back to `git rev-parse HEAD`, commitSource 'git'", () => {
    // Uses the real plugins/gateway dir in THIS repo: a real plugin.json,
    // no build-info.json (nothing in this task writes one there), inside a
    // real git checkout with commits.
    assert.ok(
      !fs.existsSync(path.join(REAL_PLUGIN_ROOT, ".claude-plugin", "build-info.json")),
      "precondition: no build-info.json should exist in the real plugin dir"
    );

    const expected = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REAL_PLUGIN_ROOT, encoding: "utf8" });
    assert.equal(expected.status, 0, "precondition: repo must be a git checkout with a HEAD commit");

    const info = getVersionInfo({ pluginRoot: REAL_PLUGIN_ROOT });
    assert.equal(info.commit, expected.stdout.trim());
    assert.equal(info.commitSource, "git");
    assert.match(info.commit, /^[0-9a-f]{40}$/);

    const pluginJson = JSON.parse(
      fs.readFileSync(path.join(REAL_PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    );
    assert.equal(info.pluginVersion, pluginJson.version, "must read version dynamically, not hardcode it");
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

  it("does NOT warn when commitSource is resolved (git)", () => {
    const originalError = console.error;
    const captured = [];
    console.error = (...args) => captured.push(args.join(" "));
    let info;
    try {
      info = executeVersion({ pluginRoot: REAL_PLUGIN_ROOT });
    } finally {
      console.error = originalError;
    }
    assert.equal(info.commitSource, "git");
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
      assert.equal(payload.commitSource, "git");
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
