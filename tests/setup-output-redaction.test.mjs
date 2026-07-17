/**
 * Cross-review fixwave 2 — F1 & F2: setup output must never leak profile
 * secrets, and setup diagnostics must never print raw baseUrl credentials/query
 * or unredacted provider errors.
 *
 * Covers:
 *   F1. `setup list --json` emits hasApiKey/hasAuthToken booleans instead of
 *       the literal apiKey/authToken values (agents can run this command).
 *   F2. `setup test` / `setup models` mask credentials + query embedded in the
 *       baseUrl they print, and `setup models` sanitizes the provider error.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const COMPANION = path.join(REPO_ROOT, "plugins/gateway/scripts/gateway-companion.mjs");

function mkConfigDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-setup-redact-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

async function runCli(args, configDir) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [COMPANION, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: configDir },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const PLANTED_API_KEY = "sk-PLANTED-apikey-9f8e7d";
const PLANTED_AUTH_TOKEN = "tok-PLANTED-authtoken-1a2b3c";

describe("setup list --json — profile secret sanitization (F1)", () => {
  it("emits hasApiKey/hasAuthToken booleans, never the literal secret values", async () => {
    const configDir = mkConfigDir({
      profiles: {
        alpha: {
          kind: "claude-gateway",
          baseUrl: "https://gw.example/v1",
          defaultModel: "m1",
          apiKey: PLANTED_API_KEY,
          authToken: PLANTED_AUTH_TOKEN,
        },
        beta: { kind: "openai-chat", baseUrl: "https://gw2.example/v1", defaultModel: "m2" },
      },
      defaultProfile: "alpha",
      reviewProfile: null,
      taskProfile: null,
    });
    try {
      const { stdout } = await runCli(["setup", "list", "--json"], configDir);
      assert.ok(!stdout.includes(PLANTED_API_KEY), "apiKey value must not appear in serialized output");
      assert.ok(!stdout.includes(PLANTED_AUTH_TOKEN), "authToken value must not appear in serialized output");

      const payload = JSON.parse(stdout);
      const alpha = payload.profiles.find((p) => p.name === "alpha");
      assert.equal(alpha.hasApiKey, true, "hasApiKey boolean must be present and true");
      assert.equal(alpha.hasAuthToken, true, "hasAuthToken boolean must be present and true");
      assert.equal(alpha.apiKey, undefined, "raw apiKey key must be gone");
      assert.equal(alpha.authToken, undefined, "raw authToken key must be gone");
      // Non-secret fields preserved verbatim.
      assert.equal(alpha.kind, "claude-gateway");
      assert.equal(alpha.baseUrl, "https://gw.example/v1");
      assert.equal(alpha.defaultModel, "m1");

      const beta = payload.profiles.find((p) => p.name === "beta");
      assert.equal(beta.hasApiKey, false);
      assert.equal(beta.hasAuthToken, false);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("setup diagnostics — baseUrl/error redaction (F2)", () => {
  const badProfile = {
    kind: "openai-chat",
    baseUrl: "https://user:pass@host.invalid/v1?token=SEKRET",
    defaultModel: "m1",
  };

  it("setup test masks credentials and query in the connectivity line", async () => {
    const configDir = mkConfigDir({ profiles: { bad: badProfile }, defaultProfile: "bad", reviewProfile: null, taskProfile: null });
    try {
      const { stderr } = await runCli(["setup", "test", "--profile", "bad"], configDir);
      assert.ok(!stderr.includes("user:pass"), "URL credentials must be masked");
      assert.ok(!stderr.includes("token=SEKRET"), "URL query must be masked");
      assert.match(stderr, /Testing connectivity to https:\/\/\[REDACTED\]@host\.invalid\/v1\?\[REDACTED\]/);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("setup models masks credentials and query in the failure line", async () => {
    const configDir = mkConfigDir({ profiles: { bad: badProfile }, defaultProfile: "bad", reviewProfile: null, taskProfile: null });
    try {
      const { stderr } = await runCli(["setup", "models", "--profile", "bad"], configDir);
      assert.ok(!stderr.includes("user:pass"), "URL credentials must be masked");
      assert.ok(!stderr.includes("token=SEKRET"), "URL query must be masked");
      assert.match(stderr, /Failed to list models from https:\/\/\[REDACTED\]@host\.invalid\/v1\?\[REDACTED\]/);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
