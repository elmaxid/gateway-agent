/**
 * Task 21 — state.mjs must be safe under concurrent multi-process writes.
 *
 * Before this task, updateState()'s docstring said outright: "not safe for
 * concurrent multi-process access; last writer wins on simultaneous
 * updates." Worse than a lost update: saveState() deletes a job's on-disk
 * file whenever that job isn't in the array it's about to write — and under
 * a race, a job that IS still meant to survive can be missing from one
 * writer's stale in-memory array purely because another process added it
 * after this writer's own read. That writer's save then deletes the other
 * process's job file too.
 *
 * These tests spawn REAL child processes (not just parallel promises --
 * Node's synchronous fs calls never actually interleave within one process,
 * so only OS-level concurrency can reproduce the race) hammering the same
 * isolated state directory, and assert nothing is lost.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadState, resolveJobFile } from "../plugins/gateway/scripts/lib/state.mjs";
import { resolveWorkspaceRoot } from "../plugins/gateway/scripts/lib/workspace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, "helpers/state-lock-worker.mjs");

function withTempState(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-lock-data-"));
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-lock-ws-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const workspaceRoot = resolveWorkspaceRoot(wsDir);
  return Promise.resolve(fn({ dataDir, wsDir, workspaceRoot })).finally(() => {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });
}

function runWorker(workspaceRoot, idPrefix, count, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, workspaceRoot, idPrefix, String(count), mode], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`worker ${idPrefix} exited ${code}: ${stderr}`));
      else resolve();
    });
  });
}

describe("state.mjs concurrency safety (Task 21)", () => {
  it("no job is lost when many child processes create distinct jobs concurrently", async () => {
    await withTempState(async ({ workspaceRoot }) => {
      const CHILDREN = 8;
      const PER_CHILD = 5;
      await Promise.all(
        Array.from({ length: CHILDREN }, (_, n) => runWorker(workspaceRoot, `p${n}`, PER_CHILD, "create"))
      );

      const state = loadState(workspaceRoot);
      assert.equal(state.jobs.length, CHILDREN * PER_CHILD, "every job from every child must be in the index");

      const ids = new Set(state.jobs.map((j) => j.id));
      assert.equal(ids.size, CHILDREN * PER_CHILD, "no duplicate/collapsed ids");

      for (const job of state.jobs) {
        const jobFile = resolveJobFile(workspaceRoot, job.id);
        assert.ok(fs.existsSync(jobFile), `job file for "${job.id}" must exist (must not be wrongly deleted)`);
      }
    });
  });

  it("concurrent updates to the SAME job id never corrupt or lose the final state", async () => {
    await withTempState(async ({ workspaceRoot }) => {
      const CHILDREN = 6;
      const PER_CHILD = 10;
      await Promise.all(
        Array.from({ length: CHILDREN }, () => runWorker(workspaceRoot, "shared-job", PER_CHILD, "update"))
      );

      const state = loadState(workspaceRoot);
      const matches = state.jobs.filter((j) => j.id === "shared-job");
      assert.equal(matches.length, 1, "exactly one entry for the shared id, never duplicated or dropped");
      assert.equal(typeof matches[0].counter, "number", "the surviving entry must be a real write, not corrupted JSON");
    });
  });

  it("concurrent creation past MAX_JOBS prunes correctly without deleting a retained job's file", async () => {
    await withTempState(async ({ workspaceRoot }) => {
      const CHILDREN = 12;
      const PER_CHILD = 6; // 72 jobs total, comfortably past state.mjs's MAX_JOBS=50
      await Promise.all(
        Array.from({ length: CHILDREN }, (_, n) => runWorker(workspaceRoot, `q${n}`, PER_CHILD, "create"))
      );

      const state = loadState(workspaceRoot);
      assert.equal(state.jobs.length, 50, "pruning caps the index at MAX_JOBS even under concurrent writers");

      for (const job of state.jobs) {
        const jobFile = resolveJobFile(workspaceRoot, job.id);
        assert.ok(fs.existsSync(jobFile), `retained job "${job.id}" must still have its file — the exact race this task closes`);
      }
    });
  });
});
