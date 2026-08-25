import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "gateway-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_FILE_NAME = "state.lock";
// Every real holder today does synchronous, sub-millisecond work (load +
// mutate + save, all sync fs calls) inside the lock -- kept short on purpose
// so a crashed holder is only presumed abandoned for a few seconds, not
// tens of seconds. staleMs < timeoutMs so a waiter recovers from a crashed
// holder by stealing well before its own timeout gives up.
const LOCK_STALE_MS = 3_000;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000; // fail loud instead of hanging forever on a stuck holder

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function sleepSync(ms) {
  // No blocking sleep exists in sync Node; Atomics.wait on a throwaway
  // buffer is the standard synchronous-sleep trick. Fine here: state.mjs's
  // whole API is deliberately synchronous, and lock waits are short.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process mutex over one workspace's state directory (index +
 * per-job files). Returns a release function; caller MUST call it in a
 * finally block.
 *
 * Keep the held section short and synchronous (load + mutate + save). A
 * lock older than LOCK_STALE_MS is presumed abandoned by a crashed holder
 * and gets stolen rather than waited on forever — a holder that's merely
 * slow (e.g. genuinely `await`ing long async work while holding it) would
 * get its lock stolen out from under it too, breaking mutual exclusion.
 * Each holder writes a random token so release() only removes the lock if
 * it's still the one this call created — never a lock a stale-steal gave to
 * someone else after this holder overstayed.
 */
export function acquireStateLock(cwd, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), LOCK_FILE_NAME);
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      return () => {
        let held;
        try {
          held = fs.readFileSync(lockFile, "utf8");
        } catch {
          return; // already gone
        }
        if (held === token) {
          try { fs.unlinkSync(lockFile); } catch { /* raced with a steal, fine */ }
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try { fs.unlinkSync(lockFile); } catch { /* another process already stole it */ }
          continue;
        }
      } catch {
        continue; // lock vanished between the EEXIST and this stat -- retry create
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for state lock (${lockFile}) after ${timeoutMs}ms — another process may be stuck.`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    const brokenPath = `${stateFile}.broken-${Date.now()}`;
    try {
      fs.renameSync(stateFile, brokenPath);
    } catch {
      // If rename fails (permissions, etc.), proceed with defaults anyway
    }
    process.stderr.write(`[gateway] corrupt state file renamed to ${brokenPath}\n`);
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
  }

  const stateFile = resolveStateFile(cwd);
  const tmpFile = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(nextState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpFile, stateFile);
  return nextState;
}

export function updateState(cwd, mutate) {
  const release = acquireStateLock(cwd);
  try {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  } finally {
    release();
  }
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  // Defense in depth even under the lock: existsSync-then-unlinkSync is its
  // own TOCTOU. try/catch ENOENT so a file already gone (e.g. removed by an
  // out-of-band cleanup) never crashes the whole state write.
  try {
    fs.unlinkSync(jobFile);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
