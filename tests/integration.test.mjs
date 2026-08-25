/**
 * Integration tests — live gateway (requires profiles glm and
 * deepseek-pro configured in ~/.gateway-plugin/config.json; no env vars).
 *
 * Covers:
 *   - Connectivity + model routing for glm-5.2, deepseek-v4-pro
 *   - Direct HTTP review (api-client chatCompletion)
 *   - Task via claude harness (subprocess)
 *   - Task via codex harness
 *   - Task via zero harness (glm profile only)
 *
 * Run: node --test --test-timeout=120000 tests/integration.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chatCompletion, testConnectivity } from "../plugins/gateway/scripts/lib/api-client.mjs";
import { loadConfig, resolveProfile } from "../plugins/gateway/scripts/lib/config.mjs";
import { runClaudeTask } from "../plugins/gateway/scripts/lib/claude-subprocess.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");

const config = loadConfig();

const MODELS = ["glm", "deepseek-pro"];

// ---------------------------------------------------------------------------
// Connectivity — one test per model
// ---------------------------------------------------------------------------

describe("gateway connectivity", () => {
  for (const profileName of MODELS) {
    it(`${profileName} responds ok`, async () => {
      const profile = resolveProfile(profileName, config);
      const result = await testConnectivity(profile);

      assert.strictEqual(result.ok, true,
        `${profileName} connectivity failed: ${result.error}`);
      assert.strictEqual(typeof result.latencyMs, "number");
      assert.ok(result.latencyMs > 0);
    });
  }
});

// ---------------------------------------------------------------------------
// Direct HTTP review — chatCompletion with a real prompt
// ---------------------------------------------------------------------------

describe("direct HTTP review", () => {
  for (const profileName of MODELS) {
    it(`${profileName} returns non-empty content`, async () => {
      const profile = resolveProfile(profileName, config);
      const result = await chatCompletion(
        profile,
        [{ role: "user", content: "Reply with exactly: OK" }],
        { max_tokens: 64 }
      );

      const msg = result.choices?.[0]?.message ?? {};
      // Thinking models may put output in reasoning_content when content is empty
      const content = msg.content || msg.reasoning_content || "";
      assert.ok(content.length > 0,
        `${profileName} returned empty content and empty reasoning_content`);
    });
  }
});

// ---------------------------------------------------------------------------
// Task via claude harness
// ---------------------------------------------------------------------------

describe("task — claude harness", () => {
  for (const profileName of MODELS) {
    it(`${profileName} executes task and returns output`, async () => {
      const profile = resolveProfile(profileName, config);
      const result = await runClaudeTask(
        profile,
        "Print the word GATEWAY and nothing else.",
        { model: profile.defaultModel, write: false }
      );

      assert.ok(result.exitCode === 0 || result.stdout.length > 0,
        `${profileName} claude task produced no output. stderr: ${result.stderr?.slice(0, 200)}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Task via codex harness — via gateway-companion CLI
// ---------------------------------------------------------------------------

describe("task — codex harness", () => {
  for (const profileName of MODELS) {
    it(`${profileName} executes task via codex and returns output`, async () => {
      let stdout = "";
      let stderr = "";
      try {
        const result = await execFileAsync(
          "node",
          [
            COMPANION, "task",
            "--profile", profileName,
            "--harness", "codex",
            "--no-write",
            "Print the word GATEWAY and nothing else."
          ],
          { timeout: 90_000 }
        );
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (err) {
        stdout = err.stdout ?? "";
        stderr = err.stderr ?? "";
        // Non-zero exit is a failure but we still check output
        assert.fail(`${profileName} codex task exited with error. stderr: ${stderr.slice(0, 300)}`);
      }

      assert.ok(stdout.length > 0,
        `${profileName} codex task produced no stdout`);
    });
  }
});

// ---------------------------------------------------------------------------
// Task via zero harness — via gateway-companion CLI
// ---------------------------------------------------------------------------

describe("task — zero harness", () => {
  it("delegates one-shot task through zero and returns clean final text", async () => {
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(
        "node",
        [
          COMPANION, "task",
          "--harness", "zero",
          "--no-write",
          "--profile", "glm",
          "Reply with exactly: INTEGRATION-ZERO-OK"
        ],
        { timeout: 90_000 }
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? "";
      // Non-zero exit fails the test immediately; stderr excerpt aids diagnosis
      assert.fail(`zero task exited with error. stderr: ${stderr.slice(0, 300)}`);
    }

    assert.match(stdout, /INTEGRATION-ZERO-OK/);
    // clean text contract: the rendered output must not be raw JSONL
    assert.ok(!stdout.includes('"type":"final"'));
  });
});
