/**
 * Task 6 — Guarda de objetivo vacío (Contrato 3).
 *
 * A review whose target has no files must not reach a model: an approval
 * with no evidence is indistinguishable from a real approval.
 *
 * The guard is `assertReviewTargetNonEmpty`. `collectReviewContext` calls it, which covers the
 * routes that pre-collect evidence; `executeReviewRun` calls it directly above the --no-tools
 * split, which covers the default agentic route. That second call site exists because the
 * agentic route never touches the collector: an earlier version of this guard lived only in
 * the collector and left the most-travelled route able to approve an empty target with exit 0.
 *
 * This file proves two things:
 *   1. Unit: the collector itself throws for an empty inventory in both
 *      target modes, with a message naming the real alternatives.
 *   2. End-to-end: every route that can reach a model (review in its default
 *      agentic mode, review --no-tools, adversarial-review, staged-review, and
 *      debate with diff context) exits non-zero AND the mock model server
 *      receives zero requests — the refusal happens before any model call.
 *
 * The CLI tests spawn the real gateway-companion.mjs binary against a mock
 * http backend, mirroring tests/cli-timeout.test.mjs. Repositories come from
 * tests/helpers/git-fixture.mjs — never built by hand.
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

import { collectReviewContext, resolveReviewTarget } from "../plugins/gateway/scripts/lib/git.mjs";
import { createTempRepo } from "./helpers/git-fixture.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");

const EXEC_TIMEOUT_MS = 15_000;

// Minimal valid OpenAI-style chat completion (kept in case a no-regression
// path ever needs it; the empty-target cases never reach the server).
const MIN_JSON_COMPLETION = JSON.stringify({ choices: [{ message: { content: "{}" } }] });

async function startCountingServer() {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(MIN_JSON_COMPLETION);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    getCount: () => count,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function writeConfigFixture(tmpDir, profiles) {
  fs.writeFileSync(
    path.join(tmpDir, "config.json"),
    JSON.stringify({ profiles, defaultProfile: null, reviewProfile: null, taskProfile: null }, null, 2)
  );
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gw-empty-target-test-"));
}

/**
 * Spawns gateway-companion.mjs with the given argv, running against a
 * repository at `repoDir` with config isolated to `tmpDir`. Never throws —
 * a non-zero exit is captured as a normal result so callers can assert on it.
 */
async function runCli(args, repoDir, tmpDir) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [COMPANION, ...args], {
      cwd: repoDir,
      env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: tmpDir },
      timeout: EXEC_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      killed: Boolean(err.killed),
    };
  }
}

// An empty repo: a single initial commit, clean working tree, still on main.
// Working-tree scope → empty inventory; --base main → empty inventory.
function emptyRepo() {
  return createTempRepo("empty-target-");
}

// ---------------------------------------------------------------------------
// Unit: the collector refuses an empty inventory
// ---------------------------------------------------------------------------

describe("Empty-target guard: collectReviewContext", () => {
  it("throws for an empty working tree and names the alternatives", () => {
    const repo = emptyRepo();
    try {
      const target = resolveReviewTarget(repo.dir, { scope: "working-tree" });
      assert.throws(
        () => collectReviewContext(repo.dir, target),
        (err) => {
          assert.match(err.message, /no files to review/i);
          assert.match(err.message, /--base <ref>/);
          assert.match(err.message, /--scope working-tree/);
          assert.match(err.message, /--scope branch/);
          assert.match(err.message, /gateway-companion task --no-write/);
          return true;
        }
      );
    } finally {
      repo.cleanup();
    }
  });

  it("throws for a branch with no diff against its base", () => {
    const repo = emptyRepo();
    try {
      const target = resolveReviewTarget(repo.dir, { base: "main" });
      assert.throws(
        () => collectReviewContext(repo.dir, target),
        (err) => {
          assert.match(err.message, /no files to review/i);
          assert.match(err.message, /--base <ref>/);
          return true;
        }
      );
    } finally {
      repo.cleanup();
    }
  });

  it("does not throw when the working tree has a change", () => {
    const repo = emptyRepo();
    try {
      fs.writeFileSync(path.join(repo.dir, "change.txt"), "a change\n");
      const target = resolveReviewTarget(repo.dir, { scope: "working-tree" });
      const context = collectReviewContext(repo.dir, target, { includeDiff: true });
      assert.equal(context.fileCount, 1);
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the four callers exit non-zero and reach no model
// ---------------------------------------------------------------------------

describe("Empty-target guard: four callers reach no model", () => {
  it("review --no-tools exits non-zero with zero model requests", async () => {
    const repo = emptyRepo();
    const tmpDir = makeTmpDir();
    const server = await startCountingServer();
    writeConfigFixture(tmpDir, {
      p1: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });
    try {
      const result = await runCli(
        ["review", "--no-tools", "--profile", "p1", "--scope", "working-tree"],
        repo.dir,
        tmpDir
      );
      assert.notStrictEqual(result.code, 0, `expected review to fail, got exit 0. stdout: ${result.stdout}`);
      assert.equal(server.getCount(), 0, `expected zero model requests, got ${server.getCount()}`);
      assert.match(result.stderr, /no files to review/i);
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });

  it("default agentic review exits non-zero with zero model requests", async () => {
    // The route the repo's own docs send people to, and the one the collector-scoped guard
    // missed: it hands the model tools instead of pre-collected context, so it never called
    // the collector. Measured before the fix: one model call, exit 0, "Verdict: approve".
    const repo = emptyRepo();
    const tmpDir = makeTmpDir();
    const server = await startCountingServer();
    writeConfigFixture(tmpDir, {
      p1: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });
    try {
      const result = await runCli(
        ["review", "--profile", "p1", "--scope", "working-tree"],
        repo.dir,
        tmpDir
      );
      assert.notStrictEqual(result.code, 0, `expected review to fail, got exit 0. stdout: ${result.stdout}`);
      assert.equal(server.getCount(), 0, `expected zero model requests, got ${server.getCount()}`);
      assert.match(result.stderr, /no files to review/i);
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });

  it("adversarial-review exits non-zero with zero model requests", async () => {
    const repo = emptyRepo();
    const tmpDir = makeTmpDir();
    const server = await startCountingServer();
    writeConfigFixture(tmpDir, {
      p1: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });
    try {
      const result = await runCli(
        ["adversarial-review", "--profile", "p1", "--scope", "working-tree"],
        repo.dir,
        tmpDir
      );
      assert.notStrictEqual(result.code, 0, `expected adversarial-review to fail, got exit 0. stdout: ${result.stdout}`);
      assert.equal(server.getCount(), 0, `expected zero model requests, got ${server.getCount()}`);
      assert.match(result.stderr, /no files to review/i);
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });

  it("staged-review exits non-zero with zero model requests", async () => {
    const repo = emptyRepo();
    const tmpDir = makeTmpDir();
    const server = await startCountingServer();
    writeConfigFixture(tmpDir, {
      p1: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });
    try {
      const result = await runCli(
        ["staged-review", "--profile", "p1", "--scope", "working-tree"],
        repo.dir,
        tmpDir
      );
      assert.notStrictEqual(result.code, 0, `expected staged-review to fail, got exit 0. stdout: ${result.stdout}`);
      assert.equal(server.getCount(), 0, `expected zero model requests, got ${server.getCount()}`);
      assert.match(result.stderr, /no files to review/i);
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });

  it("debate with diff context exits non-zero with zero model requests", async () => {
    const repo = emptyRepo();
    const tmpDir = makeTmpDir();
    const server = await startCountingServer();
    writeConfigFixture(tmpDir, {
      p1: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
      p2: { kind: "claude-gateway", baseUrl: `http://127.0.0.1:${server.port}`, defaultModel: "test-model" },
    });
    try {
      const result = await runCli(
        ["debate", "--models", "p1,p2", "--include-diff", "--scope", "working-tree", "is anything wrong?"],
        repo.dir,
        tmpDir
      );
      assert.notStrictEqual(result.code, 0, `expected debate to fail, got exit 0. stdout: ${result.stdout}`);
      assert.equal(server.getCount(), 0, `expected zero model requests, got ${server.getCount()}`);
      assert.match(result.stderr, /no files to review/i);
    } finally {
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });
});
