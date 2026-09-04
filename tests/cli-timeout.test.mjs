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

import { createTempRepo, runGit } from "./helpers/git-fixture.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");

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
 * Builds a small, controlled git repo (one staged file) so the review path
 * resolves a non-empty working-tree target without depending on whatever is
 * uncommitted in the real repository at the moment the suite runs.
 */
function makeFixtureRepo() {
  const repo = createTempRepo("gw-cli-timeout-repo-");
  fs.writeFileSync(path.join(repo.dir, "change.txt"), "timeout fixture change\n");
  runGit(repo.dir, ["add", "change.txt"]);
  return repo;
}

/**
 * Spawns gateway-companion.mjs with the given argv against a config
 * fixture isolated to tmpDir, from a controlled fixture repo (needed by
 * ensureGitRepository/collectReviewContext). Never throws — captures a
 * failed/non-zero exit as a normal result so callers can assert on it.
 */
async function runCli(args, tmpDir, cwd, envOverrides = {}) {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [COMPANION, ...args], {
      cwd,
      env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: tmpDir, ...envOverrides },
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

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`process ${pid} remained alive after ${timeoutMs}ms`);
}

async function waitForJobFailure(jobId, tmpDir, cwd, envOverrides, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runCli(["status", jobId, "--all", "--json"], tmpDir, cwd, envOverrides);
    if (result.code === 0) {
      const snapshot = JSON.parse(result.stdout);
      if (snapshot.job?.status === "failed") return snapshot.job;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`job ${jobId} did not fail within ${timeoutMs}ms`);
}

function writeHangingClaude(binDir, pidFile) {
  const bin = path.join(binDir, "claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(bin, 0o755);
}

// ---------------------------------------------------------------------------
// task --harness claude — subprocess timeout must kill the whole process tree
// ---------------------------------------------------------------------------

describe("CLI --timeout: task subprocess", () => {
  it("fails loudly as timed out and leaves no harness process behind", async () => {
    const tmpDir = makeTmpDir();
    const repo = makeFixtureRepo();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-cli-timeout-bin-"));
    const pidFile = path.join(tmpDir, "harness-pids.json");
    writeHangingClaude(binDir, pidFile);
    writeConfigFixture(tmpDir, {
      hanging: { kind: "claude-gateway", baseUrl: "http://127.0.0.1:1", defaultModel: "test-model" },
    });

    try {
      const result = await runCli(
        ["task", "--profile", "hanging", "--harness", "claude", "--timeout", "300", "hang forever"],
        tmpDir,
        repo.dir,
        { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
      );

      assert.notStrictEqual(result.code, 0, `expected task to fail, got exit 0. stdout: ${result.stdout}`);
      assert.ok(!result.killed, "expected the CLI's own --timeout to fire, not the execFileAsync backstop");
      assert.match(`${result.stdout}\n${result.stderr}`, /timed out/i);
      assert.ok(fs.existsSync(pidFile), "expected the fake harness to start before the timeout fired");

      const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
      await waitForProcessExit(pids.parent);
      await waitForProcessExit(pids.child);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });

  it("fails the stored background job as timed out and leaves no harness process behind", async () => {
    const tmpDir = makeTmpDir();
    const repo = makeFixtureRepo();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-cli-timeout-bg-bin-"));
    const pidFile = path.join(tmpDir, "background-harness-pids.json");
    const dataDir = path.join(tmpDir, "plugin-data");
    fs.mkdirSync(dataDir);
    writeHangingClaude(binDir, pidFile);
    writeConfigFixture(tmpDir, {
      hanging: { kind: "claude-gateway", baseUrl: "http://127.0.0.1:1", defaultModel: "test-model" },
    });
    const envOverrides = {
      CLAUDE_PLUGIN_DATA: dataDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    };

    try {
      const queued = await runCli(
        ["task", "--profile", "hanging", "--harness", "claude", "--timeout", "300", "--background", "--json", "hang forever"],
        tmpDir,
        repo.dir,
        envOverrides
      );

      assert.strictEqual(queued.code, 0, `expected background task to queue. stderr: ${queued.stderr}`);
      const queuedPayload = JSON.parse(queued.stdout);
      const job = await waitForJobFailure(queuedPayload.jobId, tmpDir, repo.dir, envOverrides);
      assert.match(`${job.errorMessage}\n${job.summary ?? ""}`, /timed out/i);
      assert.equal(job.status, "failed");
      assert.equal(job.pid ?? null, null);
      assert.ok(fs.existsSync(pidFile), "expected the fake harness to start before the timeout fired");

      const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
      await waitForProcessExit(pids.parent);
      await waitForProcessExit(pids.child);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// review --no-tools — single HTTP call (the only one this code path makes)
// ---------------------------------------------------------------------------

describe("CLI --timeout: review --no-tools (1 HTTP call)", () => {
  it("--timeout 300 against a hanging backend fails fast instead of hanging ~60s", async () => {
    const tmpDir = makeTmpDir();
    const repo = makeFixtureRepo();
    const server = await startMockServer(() => {
      // Never respond.
    });
    writeConfigFixture(tmpDir, {
      hanging: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });

    try {
      const result = await runCli(
        ["review", "--profile", "hanging", "--timeout", "300", "--no-tools", "--scope", "working-tree"],
        tmpDir,
        repo.dir
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
      repo.cleanup();
    }
  });

  it("(no-regression) without --timeout, succeeds against a backend that responds immediately", async () => {
    const tmpDir = makeTmpDir();
    const repo = makeFixtureRepo();
    const server = await startMockServer((count, req, res) => respondWithMinJson(res));
    writeConfigFixture(tmpDir, {
      hanging: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });

    try {
      const result = await runCli(["review", "--profile", "hanging", "--no-tools", "--scope", "working-tree"], tmpDir, repo.dir);

      assert.strictEqual(result.code, 0, `expected review to succeed with no --timeout. stderr: ${result.stderr}`);
      assert.ok(server.getCount() >= 1, "expected the mock server to have received the request");
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// adversarial-review — 2 sequential HTTP calls (pass 1, pass 2)
// ---------------------------------------------------------------------------

describe("CLI --timeout: adversarial-review (2 sequential HTTP calls)", () => {
  it("--timeout 300 against a backend that hangs only on pass 2 fails fast — proves pass 2 gets timeoutMs, not just pass 1", async () => {
    const tmpDir = makeTmpDir();
    const repo = makeFixtureRepo();
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
        tmpDir,
        repo.dir
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
      repo.cleanup();
    }
  });

  it("(no-regression) without --timeout, succeeds through both passes against a backend that responds immediately", async () => {
    const tmpDir = makeTmpDir();
    const repo = makeFixtureRepo();
    const server = await startMockServer((count, req, res) => respondWithMinJson(res));
    writeConfigFixture(tmpDir, {
      hanging2: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });

    try {
      const result = await runCli(["adversarial-review", "--profile", "hanging2", "--scope", "working-tree"], tmpDir, repo.dir);

      assert.strictEqual(result.code, 0, `expected adversarial-review to succeed with no --timeout. stderr: ${result.stderr}`);
      assert.ok(server.getCount() >= 2, `expected both passes to reach the server, got ${server.getCount()}`);
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// staged-review — 3 sequential HTTP calls (phase 1, pass 1, pass 2)
// ---------------------------------------------------------------------------

describe("CLI --timeout: staged-review (3 sequential HTTP calls)", () => {
  it("--timeout 300 against a backend that hangs only on the 3rd call fails fast — proves the last call in the chain gets timeoutMs", async () => {
    const tmpDir = makeTmpDir();
    const repo = makeFixtureRepo();
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
        tmpDir,
        repo.dir
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
      repo.cleanup();
    }
  });

  it("(no-regression) without --timeout, succeeds through all 3 calls against a backend that responds immediately", async () => {
    const tmpDir = makeTmpDir();
    const repo = makeFixtureRepo();
    const server = await startMockServer((count, req, res) => respondWithMinJson(res));
    writeConfigFixture(tmpDir, {
      hanging3: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });

    try {
      const result = await runCli(["staged-review", "--profile", "hanging3", "--scope", "working-tree"], tmpDir, repo.dir);

      assert.strictEqual(result.code, 0, `expected staged-review to succeed with no --timeout. stderr: ${result.stderr}`);
      assert.ok(server.getCount() >= 3, `expected all 3 calls to reach the server, got ${server.getCount()}`);
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The default deadline for an inline-diff review.
//
// Sending the diff inside the prompt makes one large request, and a reasoning
// model routinely spends minutes on it. The general per-request deadline is
// sized for short calls, so before this every --include-diff run aborted on any
// real diff — which made the project's own "run an adversarial review before
// each commit" rule impossible to follow: it failed with a bare "This operation
// was aborted" that named neither the cause nor the fix.
// ---------------------------------------------------------------------------

describe("resolveReviewTimeout: inline-diff runs get a deadline that fits them", () => {
  it("raises the default when the diff travels inline, and never overrides an explicit --timeout", async () => {
    const { resolveReviewTimeout } = await import("../plugins/gateway/scripts/gateway-companion.mjs");

    // No inline diff: keep the shared default (undefined = whatever the API
    // client uses). Raising it for every call would hide slow endpoints.
    assert.strictEqual(resolveReviewTimeout({}), undefined);

    // Inline diff and no explicit deadline: this is the case that used to abort.
    const inlineDefault = resolveReviewTimeout({ "include-diff": true });
    assert.ok(
      typeof inlineDefault === "number" && inlineDefault >= 300_000,
      `an inline-diff run needs minutes, got ${inlineDefault}`
    );

    // An explicit --timeout always wins, in both directions — including a value
    // SHORTER than the inline default, which is how the tests above force a
    // timeout on purpose.
    assert.strictEqual(resolveReviewTimeout({ "include-diff": true, timeout: "1000" }), 1000);
    assert.strictEqual(resolveReviewTimeout({ timeout: "1000" }), 1000);
  });
});

describe("a timed-out request explains itself", () => {
  it("names the deadline and the flag that raises it, instead of a bare abort", async () => {
    const { chatCompletion } = await import("../plugins/gateway/scripts/lib/api-client.mjs");
    const server = await startMockServer(() => { /* never responds */ });
    try {
      await assert.rejects(
        () => chatCompletion(
          { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", defaultModel: "m" },
          [{ role: "user", content: "hi" }],
          { timeoutMs: 300 }
        ),
        (err) => {
          // Still an AbortError, so non-retriable handling is unchanged.
          assert.strictEqual(err.name, "AbortError");
          // But it must say WHAT happened and HOW to fix it. A caller who only
          // sees "aborted" has no way to learn that --timeout is the answer.
          assert.match(err.message, /timed out/i);
          assert.match(err.message, /--timeout/);
          return true;
        }
      );
    } finally {
      await server.close();
    }
  });
});
