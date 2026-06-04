#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 2 * 60 * 1000;

function readHookInput() {
  try {
    if (process.stdin.isTTY) {
      return {};
    }
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[gateway] stop-review-gate: stdin read failed: ${e.message}\n`);
    return {};
  }
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRunningJobs(workspaceRoot, input) {
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  return jobs.filter((job) => {
    if (job.status !== "queued" && job.status !== "running") {
      return false;
    }
    if (job.pid && !isProcessAlive(job.pid)) {
      return false;
    }
    return true;
  });
}

async function waitForRunningJobs(workspaceRoot, input) {
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    const running = getRunningJobs(workspaceRoot, input);
    if (running.length === 0) {
      return;
    }

    const ids = running.map((job) => job.id).join(", ");
    logNote(`[gateway] Waiting for background tasks to finish: ${ids}`);
    await sleep(POLL_INTERVAL_MS);
  }

  const stillRunning = getRunningJobs(workspaceRoot, input);
  if (stillRunning.length > 0) {
    logNote(`[gateway] Warning: ${stillRunning.length} background task(s) still running after timeout:`);
    for (const job of stillRunning) {
      logNote(`[gateway]   - ${job.id} (status: ${job.status}, pid: ${job.pid ?? "unknown"}) -> /gateway:cancel ${job.id}`);
    }
    logNote(`[gateway] Use /gateway:status to check progress.`);
  }
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  const running = getRunningJobs(workspaceRoot, input);
  if (running.length === 0) {
    return;
  }

  logNote(`[gateway] ${running.length} background task(s) still running at stop time.`);
  await waitForRunningJobs(workspaceRoot, input);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
