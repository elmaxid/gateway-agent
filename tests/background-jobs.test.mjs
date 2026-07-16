/**
 * Transactional background-job lifecycle + stale-job reconciliation (Task A4).
 *
 * Covers the two combined defects in gateway-companion.mjs background task path:
 *   1. spawn-before-persist race — the worker could read a not-yet-written job
 *      and die silently under stdio:"ignore", leaving the job "queued" forever.
 *   2. invisible pre-tracking failures — any throw in the worker BEFORE
 *      runTrackedJob died silently for the same reason.
 *
 * Plus: stale-job reconciliation (dead/orphaned jobs surfaced on `status`),
 * progress-log secret redaction (Task A3 inheritance, req 9), and the
 * `:1615` codex remediation-string fix.
 *
 * All state-touching tests isolate CLAUDE_PLUGIN_DATA to a temp dir and use a
 * non-git temp workspace, so nothing touches the developer's real state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  writeJobFile,
  upsertJob
} from "../plugins/gateway/scripts/lib/state.mjs";
import {
  reconcileStaleJobs,
  DEFAULT_STALE_JOB_MS,
  readStoredJob,
  buildStatusSnapshot
} from "../plugins/gateway/scripts/lib/job-control.mjs";
import { launchBackgroundTaskWorker } from "../plugins/gateway/scripts/lib/background-launch.mjs";
import { createProgressReporter, nowIso } from "../plugins/gateway/scripts/lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../plugins/gateway/scripts/lib/workspace.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");

// --------------------------------------------------------------------------
// Isolation helpers
// --------------------------------------------------------------------------

/**
 * Runs `fn` with CLAUDE_PLUGIN_DATA pointed at a fresh temp dir and a fresh
 * non-git temp workspace. state.mjs reads the env var at call time, so setting
 * it here is enough for both in-process and child-process state resolution.
 */
function withTempState(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-bgjob-data-"));
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-bgjob-ws-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const workspaceRoot = resolveWorkspaceRoot(wsDir);
  try {
    return fn({ dataDir, wsDir, workspaceRoot });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
}

function makeJob(workspaceRoot, id = "task-test") {
  return { id, kind: "task", jobClass: "task", title: "Gateway Task", workspaceRoot, createdAt: nowIso() };
}

function sampleRequest(wsDir) {
  return {
    cwd: wsDir,
    profile: "test-profile",
    model: null,
    write: true,
    prompt: "print hello",
    persona: null,
    harness: "claude"
  };
}

// --------------------------------------------------------------------------
// 1-3: transactional launch sequence
// --------------------------------------------------------------------------

describe("launchBackgroundTaskWorker — transactional launch", () => {
  it("persists the job with request + status:starting BEFORE the worker is spawned", () => {
    withTempState(({ workspaceRoot, wsDir, dataDir }) => {
      const job = makeJob(workspaceRoot, "task-starting");
      const request = sampleRequest(wsDir);
      const logFile = path.join(dataDir, "job.log");

      let observed = null;
      const result = launchBackgroundTaskWorker(
        { job, workspaceRoot, request, logFile },
        {
          spawnFn: () => {
            // At the exact moment of spawn the job file must already exist,
            // carrying the full request and status:"starting".
            observed = readStoredJob(workspaceRoot, job.id);
            return { pid: 4242 };
          },
          secrets: []
        }
      );

      assert.ok(observed, "spawnFn should have run");
      assert.equal(observed.status, "starting");
      assert.deepEqual(observed.request, request);
      assert.equal(result.status, "queued");
    });
  });

  it("spawn success → job file ends queued with the child pid", () => {
    withTempState(({ workspaceRoot, wsDir, dataDir }) => {
      const job = makeJob(workspaceRoot, "task-queued");
      const request = sampleRequest(wsDir);
      const logFile = path.join(dataDir, "job.log");

      const result = launchBackgroundTaskWorker(
        { job, workspaceRoot, request, logFile },
        { spawnFn: () => ({ pid: 4242 }), secrets: [] }
      );

      assert.equal(result.status, "queued");
      const stored = readStoredJob(workspaceRoot, job.id);
      assert.equal(stored.status, "queued");
      assert.equal(stored.pid, 4242);
      assert.deepEqual(stored.request, request);
    });
  });

  it("spawn throws synchronously → job file ends failed with an errorMessage, no pid", () => {
    withTempState(({ workspaceRoot, wsDir, dataDir }) => {
      const job = makeJob(workspaceRoot, "task-spawnfail");
      const request = sampleRequest(wsDir);
      const logFile = path.join(dataDir, "job.log");

      const result = launchBackgroundTaskWorker(
        { job, workspaceRoot, request, logFile },
        {
          spawnFn: () => {
            throw new Error("EMFILE: too many open files, spawn");
          },
          secrets: []
        }
      );

      assert.equal(result.status, "failed");
      const stored = readStoredJob(workspaceRoot, job.id);
      assert.equal(stored.status, "failed");
      assert.equal(stored.phase, "failed");
      assert.ok(stored.errorMessage && stored.errorMessage.length > 0, "must persist an errorMessage");
      assert.equal(stored.pid ?? null, null);
    });
  });

  it("redacts config secrets from the persisted launch errorMessage", () => {
    withTempState(({ workspaceRoot, wsDir, dataDir }) => {
      const job = makeJob(workspaceRoot, "task-secret");
      const request = sampleRequest(wsDir);
      const logFile = path.join(dataDir, "job.log");

      const result = launchBackgroundTaskWorker(
        { job, workspaceRoot, request, logFile },
        {
          spawnFn: () => {
            throw new Error("spawn failed talking to Bearer sk-LEAK-999");
          },
          secrets: ["sk-LEAK-999"]
        }
      );

      assert.equal(result.status, "failed");
      const stored = readStoredJob(workspaceRoot, job.id);
      assert.ok(!stored.errorMessage.includes("sk-LEAK-999"), "secret must not leak into the job file");
    });
  });
});

// --------------------------------------------------------------------------
// 4: worker fails loud before runTrackedJob (real CLI invocation)
// --------------------------------------------------------------------------

describe("task-worker — pre-tracking failures are persisted, not silent", () => {
  it("stored job missing its request → job file ends failed with errorMessage", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-bgjob-cli-data-"));
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-bgjob-cli-ws-"));
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-bgjob-cli-cfg-"));
    const prev = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    const workspaceRoot = resolveWorkspaceRoot(wsDir);
    const jobId = "task-worker-norequest";

    try {
      // A stored job with NO `request` payload — the worker must fail loud into
      // the job file instead of dying silently under stdio:"ignore".
      const rec = {
        id: jobId,
        status: "queued",
        phase: "queued",
        title: "Gateway Task",
        jobClass: "task",
        kind: "task",
        pid: 999999,
        logFile: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      writeJobFile(workspaceRoot, jobId, rec);
      upsertJob(workspaceRoot, rec);

      let exitCode = 0;
      try {
        await execFileAsync(
          process.execPath,
          [COMPANION, "task-worker", "--job-id", jobId, "--cwd", wsDir],
          { env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, GATEWAY_PLUGIN_CONFIG_DIR: cfgDir }, timeout: 20_000 }
        );
      } catch (err) {
        // Fail-loud path: a non-zero exit is expected. We assert on persisted state.
        exitCode = typeof err.code === "number" ? err.code : 1;
      }

      const stored = readStoredJob(workspaceRoot, jobId);
      assert.ok(stored, "job file should still exist");
      assert.equal(stored.status, "failed", `expected failed, got ${stored.status} (exit ${exitCode})`);
      assert.ok(stored.errorMessage && /request/i.test(stored.errorMessage), `errorMessage should mention the missing request, got: ${stored.errorMessage}`);
      assert.equal(stored.pid ?? null, null);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = prev;
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(wsDir, { recursive: true, force: true });
      fs.rmSync(cfgDir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// 5: reconcileStaleJobs (pure)
// --------------------------------------------------------------------------

describe("reconcileStaleJobs", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const dead = () => false;
  const alive = () => true;
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

  it("has a sane default stale threshold (5 min)", () => {
    assert.equal(DEFAULT_STALE_JOB_MS, 5 * 60 * 1000);
  });

  it("running job whose pid is gone → failed", () => {
    const patches = reconcileStaleJobs(
      [{ id: "r", status: "running", pid: 1234, updatedAt: iso(0) }],
      { isPidAlive: dead, now, staleMs: 300_000 }
    );
    assert.equal(patches.length, 1);
    assert.equal(patches[0].id, "r");
    assert.equal(patches[0].status, "failed");
    assert.match(patches[0].errorMessage, /1234/);
    assert.equal(patches[0].pid ?? null, null);
  });

  it("running job whose pid is alive → untouched", () => {
    const patches = reconcileStaleJobs(
      [{ id: "r", status: "running", pid: 1234, updatedAt: iso(0) }],
      { isPidAlive: alive, now, staleMs: 300_000 }
    );
    assert.equal(patches.length, 0);
  });

  it("queued job with a dead pid → failed", () => {
    const patches = reconcileStaleJobs(
      [{ id: "q", status: "queued", pid: 4242, updatedAt: iso(0) }],
      { isPidAlive: dead, now, staleMs: 300_000 }
    );
    assert.equal(patches.length, 1);
    assert.equal(patches[0].status, "failed");
  });

  it("stale queued job with no pid (older than threshold) → failed", () => {
    const patches = reconcileStaleJobs(
      [{ id: "q", status: "queued", pid: null, updatedAt: iso(-600_000) }],
      { isPidAlive: dead, now, staleMs: 300_000 }
    );
    assert.equal(patches.length, 1);
    assert.equal(patches[0].status, "failed");
  });

  it("recent queued job with no pid (younger than threshold) → untouched", () => {
    const patches = reconcileStaleJobs(
      [{ id: "q", status: "queued", pid: null, updatedAt: iso(-1_000) }],
      { isPidAlive: dead, now, staleMs: 300_000 }
    );
    assert.equal(patches.length, 0);
  });

  it("starting job with a dead pid → failed", () => {
    const patches = reconcileStaleJobs(
      [{ id: "s", status: "starting", pid: 4242, updatedAt: iso(0) }],
      { isPidAlive: dead, now, staleMs: 300_000 }
    );
    assert.equal(patches.length, 1);
    assert.equal(patches[0].status, "failed");
  });

  it("terminal jobs are never reaped", () => {
    const patches = reconcileStaleJobs(
      [
        { id: "c", status: "completed", pid: 1, updatedAt: iso(-999_999) },
        { id: "f", status: "failed", pid: 1, updatedAt: iso(-999_999) },
        { id: "x", status: "cancelled", pid: 1, updatedAt: iso(-999_999) }
      ],
      { isPidAlive: dead, now, staleMs: 300_000 }
    );
    assert.equal(patches.length, 0);
  });

  it("buildStatusSnapshot applies reconciliation patches to disk (caller wiring)", () => {
    withTempState(({ workspaceRoot, wsDir }) => {
      const id = "task-dead-running";
      const rec = {
        id,
        status: "running",
        phase: "running",
        pid: 999999,
        title: "Gateway Task",
        jobClass: "task",
        kind: "task",
        logFile: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      writeJobFile(workspaceRoot, id, rec);
      upsertJob(workspaceRoot, rec);

      const snapshot = buildStatusSnapshot(wsDir, { isPidAlive: () => false });

      const stored = readStoredJob(workspaceRoot, id);
      assert.equal(stored.status, "failed", "status build should reap the dead running job on disk");
      assert.ok(stored.errorMessage && stored.errorMessage.length > 0);
      assert.ok(
        !snapshot.running.some((j) => j.id === id),
        "reaped job should no longer be reported as running"
      );
    });
  });
});

// --------------------------------------------------------------------------
// 6: progress-log secret redaction (Task A3 inheritance — req 9)
// --------------------------------------------------------------------------

describe("createProgressReporter — progress-log redaction (req 9)", () => {
  it("redacts config secrets from a persisted progress line when secrets are provided", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-bgjob-prog-"));
    const logFile = path.join(dir, "p.log");
    fs.writeFileSync(logFile, "");
    try {
      const reporter = createProgressReporter({ logFile, secrets: ["sk-SECRET-123"] });
      reporter({ message: "harness stderr: auth Bearer sk-SECRET-123 failed" });
      const body = fs.readFileSync(logFile, "utf8");
      assert.ok(!body.includes("sk-SECRET-123"), "secret must not reach the job log");
      assert.match(body, /\[REDACTED\]/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves progress lines byte-identical when no secrets option is passed (foreground unchanged)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-bgjob-prog2-"));
    const logFile = path.join(dir, "p.log");
    fs.writeFileSync(logFile, "");
    try {
      const reporter = createProgressReporter({ logFile });
      reporter({ message: "reviewing url https://ex.com/a?x=y stays intact" });
      const body = fs.readFileSync(logFile, "utf8");
      assert.match(body, /https:\/\/ex\.com\/a\?x=y stays intact/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// 7: :1615 codex remediation string
// --------------------------------------------------------------------------

describe("dispatch codex remediation string (:1615 fix)", () => {
  it("recommends @openai/codex and never the nonexistent @anthropic-ai/codex", () => {
    const src = fs.readFileSync(COMPANION, "utf8");
    assert.ok(src.includes("npm i -g @openai/codex"), "must recommend @openai/codex");
    assert.ok(!src.includes("@anthropic-ai/codex"), "must not recommend @anthropic-ai/codex");
  });
});
