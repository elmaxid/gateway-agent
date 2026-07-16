import fs from "node:fs";

import { getConfig, listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

// A background worker that dies (crash, OOM-kill, host reboot) before writing a
// terminal status leaves its job stuck in running/queued/starting. Reconciliation
// detects those on-demand when the user runs `status` — there is no daemon.
export const DEFAULT_STALE_JOB_MS = 5 * 60 * 1000;

// Known limitation (accepted for this hotfix): kill(pid, 0) cannot tell a live
// worker apart from an unrelated process that reused a recycled pid. A reused
// pid can make a dead worker look alive (job left running) — the age threshold
// mitigates the no-pid case; a full fix (heartbeat) is deferred to v0.6.
function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but we may not signal it → treat as alive.
    return err && err.code === "EPERM";
  }
}

function makeFailedPatch(job, reason, now) {
  return {
    id: job.id,
    status: "failed",
    phase: "failed",
    pid: null,
    errorMessage: reason,
    completedAt: new Date(now).toISOString()
  };
}

/**
 * Pure: given the current jobs, return the list of "failed" patches for any job
 * whose worker is gone. Never mutates its input or touches disk — the caller
 * applies the patches.
 *
 * @param {object[]} jobs
 * @param {{isPidAlive?: (pid:number)=>boolean, now?: number, staleMs?: number}} [opts]
 * @returns {Array<{id:string,status:"failed",phase:"failed",pid:null,errorMessage:string,completedAt:string}>}
 */
export function reconcileStaleJobs(jobs, opts = {}) {
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_STALE_JOB_MS;

  const patches = [];
  for (const job of jobs ?? []) {
    if (!job || typeof job !== "object") {
      continue;
    }
    const pid = Number(job.pid);
    const hasPid = Number.isInteger(pid) && pid > 0;

    if (job.status === "running") {
      // runTrackedJob always records pid = process.pid, so a running job with a
      // dead pid means the worker process is gone.
      if (hasPid && !isPidAlive(pid)) {
        patches.push(makeFailedPatch(job, `worker process died (pid ${pid} not found)`, now));
      }
      continue;
    }

    if (job.status === "starting" || job.status === "queued") {
      if (hasPid) {
        if (!isPidAlive(pid)) {
          patches.push(makeFailedPatch(job, `worker process is gone before it started running (pid ${pid} not found)`, now));
        }
        continue;
      }
      // No pid recorded (spawn never confirmed): only reap once it is clearly
      // stale, so we don't race a worker that is mid-launch.
      const timestamp = Date.parse(job.updatedAt ?? job.createdAt ?? "");
      if (Number.isFinite(timestamp) && now - timestamp > staleMs) {
        const ageSeconds = Math.round((now - timestamp) / 1000);
        patches.push(makeFailedPatch(job, `worker never started (no pid, stale for ${ageSeconds}s)`, now));
      }
    }
  }
  return patches;
}

function applyReconcilePatch(workspaceRoot, patch) {
  const existing = readStoredJob(workspaceRoot, patch.id);
  if (existing) {
    writeJobFile(workspaceRoot, patch.id, { ...existing, ...patch });
  }
  upsertJob(workspaceRoot, patch);
}

/**
 * Reconcile dead/orphaned jobs on-demand (no daemon): compute the "failed"
 * patches via the pure reconcileStaleJobs, persist each to disk, and return the
 * in-memory job list with those patches applied. Shared by every read path
 * (`status`, `status <id>`, `result <id>`) so a dead worker's job never reads
 * as running/queued from any of them.
 */
function reconcileJobsOnRead(workspaceRoot, jobs, options = {}) {
  const patches = reconcileStaleJobs(jobs, {
    isPidAlive: options.isPidAlive,
    now: options.now,
    staleMs: options.staleMs
  });
  const patchById = new Map();
  for (const patch of patches) {
    applyReconcilePatch(workspaceRoot, patch);
    patchById.set(patch.id, patch);
  }
  return jobs.map((job) => (patchById.has(job.id) ? { ...job, ...patchById.get(job.id) } : job));
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting gateway") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("gateway error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /gateway:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  // Reconcile dead/orphaned background jobs on-demand (no daemon) so `status`
  // never reports a job as running/queued when its worker is gone. Runs over
  // all jobs (not just this session's) so cross-session cleanup happens too.
  const reconciledJobs = reconcileJobsOnRead(workspaceRoot, listJobs(workspaceRoot), options);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(reconciledJobs, options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Reconcile on-demand so `status <id>` reports a dead worker's job as failed
  // instead of a stuck running/queued (parity with bare `status`).
  const reconciledJobs = reconcileJobsOnRead(workspaceRoot, listJobs(workspaceRoot), options);
  const jobs = sortJobsNewestFirst(reconciledJobs);
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /gateway:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Reconcile on-demand so `result <id>` treats a dead worker's job as a
  // finished (failed) result instead of throwing "still running" forever.
  const reconciledJobs = reconcileJobsOnRead(workspaceRoot, listJobs(workspaceRoot), options);
  const jobs = sortJobsNewestFirst(reference ? reconciledJobs : filterJobsForCurrentSession(reconciledJobs));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /gateway:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /gateway:status to inspect active jobs.`);
  }

  throw new Error("No finished Gateway jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Gateway jobs are active. Pass a job id to /gateway:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Gateway jobs to cancel for this session.");
  }

  throw new Error("No active Gateway jobs to cancel.");
}
