/**
 * Deterministic CLI end-to-end tests for the `--timeout <ms>` flag.
 *
 * Spawns the real gateway-companion.mjs binary as a child process (real argv,
 * real process exit code) against local http.createServer mock backends —
 * no real gateway required, fully portable/reproducible.
 *
 * `adversarial-review` makes 2 sequential HTTP calls (pass 1, pass 2) and
 * `staged-review` makes 3 (phase 1, pass 1, pass 2). A test that only hangs
 * the FIRST request would only prove the first call got the timeout. So the
 * mock servers for those two commands are stateful: they answer every call
 * before the target with a valid minimal JSON completion, and only hang on
 * the target (last) call — proving timeoutMs reaches every call in the
 * chain, not just the first one hit.
 *
 * See tests/debate.test.mjs for the same GATEWAY_PLUGIN_CONFIG_DIR isolation
 * pattern used here (adapted for a spawned child process, which needs the
 * env var passed explicitly via `env:` rather than set on `process.env`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");
const REPO_ROOT = path.join(__dirname, "..");

// Backstop only, for the test runner — should never actually be what fires
// in a passing test. The `--timeout 300` flag inside the CLI is what should
// cause the fast exit.
const EXEC_TIMEOUT_MS = 15_000;
// Generous margin: well under EXEC_TIMEOUT_MS and orders of magnitude under
// the real ~60s default request timeout these tests exist to guard against.
const FAST_EXIT_MS = 10_000;

// Minimal valid OpenAI-style chat completion. Content is a parseable (if
// schema-empty) JSON object so extractJson()/JSON.parse() downstream succeed.
const MIN_JSON_COMPLETION = JSON.stringify({ choices: [{ message: { content: "{}" } }] });

/**
 * Starts an http.createServer mock on 127.0.0.1:0 (OS-assigned port).
 * `onRequest(count, req, res)` is invoked once per request with a 1-based
 * request count; it decides whether to respond (stateful servers answer
 * calls before the target) or leave the response hanging (simulating a
 * dead/slow backend on the target call). The request body is always
 * drained via req.resume() so keep-alive connections used for sequential
 * calls don't desync.
 */
async function startMockServer(onRequest) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    req.resume();
    onRequest(count, req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    getCount: () => count,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function respondWithMinJson(res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(MIN_JSON_COMPLETION);
}

function writeConfigFixture(tmpDir, profiles) {
  fs.writeFileSync(
    path.join(tmpDir, "config.json"),
    JSON.stringify({ profiles, defaultProfile: null, reviewProfile: null, taskProfile: null }, null, 2)
  );
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gw-cli-timeout-test-"));
}

/**
 * Spawns gateway-companion.mjs with the given argv against a config
 * fixture isolated to tmpDir, from REPO_ROOT (a real git repo, needed by
 * ensureGitRepository/collectReviewContext). Never throws — captures a
 * failed/non-zero exit as a normal result so callers can assert on it.
 */
async function runCli(args, tmpDir) {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [COMPANION, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: tmpDir },
      timeout: EXEC_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr, durationMs: Date.now() - start };
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      durationMs: Date.now() - start,
      killed: Boolean(err.killed),
    };
  }
}

// ---------------------------------------------------------------------------
// review --no-tools — single HTTP call (the only one this code path makes)
// ---------------------------------------------------------------------------

describe("CLI --timeout: review --no-tools (1 HTTP call)", () => {
  it("--timeout 300 against a hanging backend fails fast instead of hanging ~60s", async () => {
    const tmpDir = makeTmpDir();
    const server = await startMockServer(() => {
      // Never respond.
    });
    writeConfigFixture(tmpDir, {
      hanging: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });

    try {
      const result = await runCli(
        ["review", "--profile", "hanging", "--timeout", "300", "--no-tools", "--scope", "working-tree"],
        tmpDir
      );

      assert.notStrictEqual(result.code, 0, `expected review to fail fast, got exit 0. stdout: ${result.stdout}`);
      assert.ok(!result.killed, "expected the CLI's own --timeout to fire, not the execFileAsync backstop");
      assert.ok(
        result.durationMs < FAST_EXIT_MS,
        `expected review --timeout 300 to exit well under ${FAST_EXIT_MS}ms, took ${result.durationMs}ms`
      );
      assert.ok(server.getCount() >= 1, "expected the mock server to have received the (only) request");
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("(no-regression) without --timeout, succeeds against a backend that responds immediately", async () => {
    const tmpDir = makeTmpDir();
    const server = await startMockServer((count, req, res) => respondWithMinJson(res));
    writeConfigFixture(tmpDir, {
      hanging: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });

    try {
      const result = await runCli(["review", "--profile", "hanging", "--no-tools", "--scope", "working-tree"], tmpDir);

      assert.strictEqual(result.code, 0, `expected review to succeed with no --timeout. stderr: ${result.stderr}`);
      assert.ok(server.getCount() >= 1, "expected the mock server to have received the request");
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// adversarial-review — 2 sequential HTTP calls (pass 1, pass 2)
// ---------------------------------------------------------------------------

describe("CLI --timeout: adversarial-review (2 sequential HTTP calls)", () => {
  it("--timeout 300 against a backend that hangs only on pass 2 fails fast — proves pass 2 gets timeoutMs, not just pass 1", async () => {
    const tmpDir = makeTmpDir();
    const server = await startMockServer((count, req, res) => {
      if (count === 1) {
        // Pass 1: respond normally.
        respondWithMinJson(res);
      }
      // Pass 2 (count === 2, the target): never respond.
    });
    writeConfigFixture(tmpDir, {
      hanging2: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });

    try {
      const result = await runCli(
        ["adversarial-review", "--profile", "hanging2", "--timeout", "300", "--scope", "working-tree"],
        tmpDir
      );

      assert.notStrictEqual(result.code, 0, `expected adversarial-review to fail fast, got exit 0. stdout: ${result.stdout}`);
      assert.ok(!result.killed, "expected the CLI's own --timeout to fire, not the execFileAsync backstop");
      assert.ok(
        result.durationMs < FAST_EXIT_MS,
        `expected adversarial-review --timeout 300 to exit well under ${FAST_EXIT_MS}ms, took ${result.durationMs}ms`
      );
      assert.ok(
        server.getCount() >= 2,
        `expected the server to have received both pass 1 and pass 2 requests, got ${server.getCount()}`
      );
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("(no-regression) without --timeout, succeeds through both passes against a backend that responds immediately", async () => {
    const tmpDir = makeTmpDir();
    const server = await startMockServer((count, req, res) => respondWithMinJson(res));
    writeConfigFixture(tmpDir, {
      hanging2: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });

    try {
      const result = await runCli(["adversarial-review", "--profile", "hanging2", "--scope", "working-tree"], tmpDir);

      assert.strictEqual(result.code, 0, `expected adversarial-review to succeed with no --timeout. stderr: ${result.stderr}`);
      assert.ok(server.getCount() >= 2, `expected both passes to reach the server, got ${server.getCount()}`);
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// staged-review — 3 sequential HTTP calls (phase 1, pass 1, pass 2)
// ---------------------------------------------------------------------------

describe("CLI --timeout: staged-review (3 sequential HTTP calls)", () => {
  it("--timeout 300 against a backend that hangs only on the 3rd call fails fast — proves the last call in the chain gets timeoutMs", async () => {
    const tmpDir = makeTmpDir();
    const server = await startMockServer((count, req, res) => {
      if (count === 1 || count === 2) {
        // Phase 1, then pass 1: respond normally.
        respondWithMinJson(res);
      }
      // Pass 2 (count === 3, the target): never respond.
    });
    writeConfigFixture(tmpDir, {
      hanging3: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });

    try {
      const result = await runCli(
        ["staged-review", "--profile", "hanging3", "--timeout", "300", "--scope", "working-tree"],
        tmpDir
      );

      assert.notStrictEqual(result.code, 0, `expected staged-review to fail fast, got exit 0. stdout: ${result.stdout}`);
      assert.ok(!result.killed, "expected the CLI's own --timeout to fire, not the execFileAsync backstop");
      assert.ok(
        result.durationMs < FAST_EXIT_MS,
        `expected staged-review --timeout 300 to exit well under ${FAST_EXIT_MS}ms, took ${result.durationMs}ms`
      );
      assert.ok(
        server.getCount() >= 3,
        `expected the server to have received phase 1, pass 1, and pass 2 requests, got ${server.getCount()}`
      );
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("(no-regression) without --timeout, succeeds through all 3 calls against a backend that responds immediately", async () => {
    const tmpDir = makeTmpDir();
    const server = await startMockServer((count, req, res) => respondWithMinJson(res));
    writeConfigFixture(tmpDir, {
      hanging3: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });

    try {
      const result = await runCli(["staged-review", "--profile", "hanging3", "--scope", "working-tree"], tmpDir);

      assert.strictEqual(result.code, 0, `expected staged-review to succeed with no --timeout. stderr: ${result.stderr}`);
      assert.ok(server.getCount() >= 3, `expected all 3 calls to reach the server, got ${server.getCount()}`);
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
