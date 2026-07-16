/**
 * Task A1 — standalone baseline capture script for v0.5.1 workstations
 * (v0.5.2 hotfix plan §4).
 *
 * scripts/baseline-capture.mjs must be import-safe (main() guarded by a
 * process.argv[1] comparison) and self-contained (no repo imports) — see the
 * file header there for why. These tests exercise its exported pure
 * functions directly:
 *
 *   1. buildConfigSection() sanitizes apiKey/authToken to booleans — the
 *      literal secret value must never appear anywhere in the serialized
 *      JSON.
 *   2. sanitizeBaseUrl() reduces a URL with credentials or a query string to
 *      host-only; a clean URL passes through unchanged.
 *   3. getPluginVersionInfo() resolves version+commit from a fixture
 *      pluginRoot (plugin.json + build-info.json), falls back to `git
 *      rev-parse HEAD` for a git checkout with no build-info.json, and
 *      reports "unknown" when neither is available.
 *   4. redactMatrixOutput() masks Bearer tokens and known literal secrets in
 *      matrix stdout/stderr text.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildConfigSection,
  sanitizeBaseUrl,
  getPluginVersionInfo,
  redactMatrixOutput,
  resolveGatewayInvocation,
} from "../scripts/baseline-capture.mjs";

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePluginJson(pluginRoot, version) {
  const dir = path.join(pluginRoot, ".claude-plugin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "gateway", version }));
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Profile secret sanitization — no literal secret anywhere in the JSON.
// ---------------------------------------------------------------------------

describe("buildConfigSection — profile secret sanitization", () => {
  it("reports booleans only; the literal apiKey/authToken value never appears in the serialized JSON", () => {
    const apiKeySecret = "sk-live-verysecret-abc123";
    const authTokenSecret = "tok-verysecret-xyz789";
    const config = {
      defaultProfile: "profile-a",
      reviewProfile: "profile-a",
      taskProfile: "profile-a",
      profiles: {
        "profile-a": {
          kind: "claude-gateway",
          defaultModel: "some-model",
          baseUrl: "https://gw.example.com",
          apiKey: apiKeySecret,
          authToken: authTokenSecret,
        },
      },
    };

    const section = buildConfigSection({
      config,
      configPath: "/fake/config.json",
      found: true,
      error: null,
      gatewayApiKeyEnvPresent: true,
    });

    const serialized = JSON.stringify(section);
    assert.ok(!serialized.includes(apiKeySecret), "apiKey value must not leak into serialized output");
    assert.ok(!serialized.includes(authTokenSecret), "authToken value must not leak into serialized output");

    const profile = section.profiles.find((p) => p.name === "profile-a");
    assert.ok(profile, "profile-a must be present in the summary");
    assert.equal(profile.hasApiKey, true);
    assert.equal(profile.hasAuthToken, true);
    assert.equal(profile.hasGatewayApiKeyEnv, true);
    assert.equal(profile.kind, "claude-gateway");
    assert.equal(profile.model, "some-model");
    assert.equal(section.roles.defaultProfile, "profile-a");
  });

  it("reports false booleans when apiKey/authToken/env var are absent", () => {
    const config = {
      defaultProfile: null,
      reviewProfile: null,
      taskProfile: null,
      profiles: { bare: { kind: "openai-chat", defaultModel: "m" } },
    };
    const section = buildConfigSection({
      config,
      configPath: "/fake/config.json",
      found: true,
      error: null,
      gatewayApiKeyEnvPresent: false,
    });
    const profile = section.profiles.find((p) => p.name === "bare");
    assert.equal(profile.hasApiKey, false);
    assert.equal(profile.hasAuthToken, false);
    assert.equal(profile.hasGatewayApiKeyEnv, false);
  });
});

// ---------------------------------------------------------------------------
// 2. baseUrl sanitization — host-only when creds/query present.
// ---------------------------------------------------------------------------

describe("sanitizeBaseUrl", () => {
  it("reduces a URL with embedded credentials to scheme://host only", () => {
    const out = sanitizeBaseUrl("https://user:sk-secret-pass@gw.example.com:8443/v1");
    assert.equal(out, "https://gw.example.com:8443");
    assert.ok(!out.includes("sk-secret-pass"));
  });

  it("reduces a URL with a query string to scheme://host only", () => {
    const out = sanitizeBaseUrl("https://gw.example.com/v1/chat?api_key=sk-secret-xyz&t=1");
    assert.equal(out, "https://gw.example.com");
    assert.ok(!out.includes("sk-secret-xyz"));
  });

  it("passes through a clean URL (no credentials, no query) unchanged", () => {
    const out = sanitizeBaseUrl("https://gw.example.com:8443/v1");
    assert.equal(out, "https://gw.example.com:8443/v1");
  });
});

// ---------------------------------------------------------------------------
// 3. Plugin version/commit detection via fixture pluginRoot.
// ---------------------------------------------------------------------------

describe("getPluginVersionInfo", () => {
  it("reads version from plugin.json and commit from build-info.json when present", () => {
    const tmp = mkTmp("baseline-version-buildinfo-");
    try {
      const pluginDir = writePluginJson(tmp, "9.9.9");
      const fakeCommit = "b".repeat(40);
      fs.writeFileSync(
        path.join(pluginDir, "build-info.json"),
        JSON.stringify({ commit: fakeCommit, builtAt: new Date().toISOString() })
      );

      const info = getPluginVersionInfo(tmp);
      assert.equal(info.version, "9.9.9");
      assert.equal(info.commit, fakeCommit);
      assert.equal(info.commitSource, "build-info");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to `git rev-parse HEAD` when no build-info.json but pluginRoot is a git checkout", () => {
    const tmp = mkTmp("baseline-version-git-");
    try {
      writePluginJson(tmp, "2.0.0");
      spawnSync("git", ["init", "-q"], { cwd: tmp });
      spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: tmp });
      spawnSync("git", ["config", "user.name", "test"], { cwd: tmp });
      spawnSync("git", ["add", "."], { cwd: tmp });
      spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp });

      const expected = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" });
      assert.equal(expected.status, 0, "precondition: tmp must be a git checkout with a HEAD commit");

      const info = getPluginVersionInfo(tmp);
      assert.equal(info.version, "2.0.0");
      assert.equal(info.commit, expected.stdout.trim());
      assert.equal(info.commitSource, "git");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports commit 'unknown' when there is neither build-info.json nor a git checkout", () => {
    const tmp = mkTmp("baseline-version-unknown-");
    try {
      writePluginJson(tmp, "1.2.3");
      const info = getPluginVersionInfo(tmp);
      assert.equal(info.version, "1.2.3");
      assert.equal(info.commit, "unknown");
      assert.equal(info.commitSource, "unknown");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Matrix output redaction.
// ---------------------------------------------------------------------------

describe("redactMatrixOutput", () => {
  it("masks Bearer tokens and a known literal secret", () => {
    const secret = "sk-matrix-secret-999";
    const text = `Authorization: Bearer sk-abc123XYZ\nconnect failed with key ${secret} at endpoint\nok`;
    const out = redactMatrixOutput(text, [secret]);
    assert.ok(!out.includes("sk-abc123XYZ"), "Bearer token must be gone");
    assert.ok(!out.includes(secret), "literal secret must be scrubbed");
    assert.match(out, /Bearer \[REDACTED\]/);
    assert.match(out, /\[REDACTED\]/);
  });

  it("bounds output to the first 20 lines", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = redactMatrixOutput(text, []);
    const lines = out.split("\n");
    assert.equal(lines.length, 21, "20 kept lines + 1 omitted-marker line");
    assert.equal(lines[19], "line 20");
    assert.equal(lines[20], "[... 20 lines omitted]");
  });
});

// ---------------------------------------------------------------------------
// 5. --run-matrix invocation prefers the inventoried install's script (fix #5)
// ---------------------------------------------------------------------------

describe("resolveGatewayInvocation", () => {
  it("prefers node <pluginRoot>/scripts/gateway-companion.mjs over a PATH bin", () => {
    // On a workstation with several installs, PATH may resolve a DIFFERENT
    // install than the one this capture inventoried — so the pinned pluginRoot
    // script must win over the PATH bin regardless of PATH contents.
    const tmp = mkTmp("baseline-invocation-");
    try {
      const scriptDir = path.join(tmp, "scripts");
      fs.mkdirSync(scriptDir, { recursive: true });
      const scriptPath = path.join(scriptDir, "gateway-companion.mjs");
      fs.writeFileSync(scriptPath, "// fixture\n");

      const invocation = resolveGatewayInvocation({ pluginRoot: tmp });
      assert.equal(invocation.cmd, process.execPath, "must run the pinned script via node");
      assert.deepEqual(invocation.baseArgs, [scriptPath], "must target the inventoried install's script");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when the pluginRoot has no script and no PATH bin is available", () => {
    const tmp = mkTmp("baseline-invocation-none-");
    try {
      // No scripts/ dir under this pluginRoot. With gateway-companion almost
      // certainly absent from PATH in the test env, resolution yields null.
      const invocation = resolveGatewayInvocation({ pluginRoot: tmp });
      if (invocation !== null) {
        // gateway-companion happens to be installed on PATH in this env — the
        // only acceptable non-null result is the PATH bin as a last resort.
        assert.equal(invocation.cmd, "gateway-companion");
        assert.deepEqual(invocation.baseArgs, []);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
