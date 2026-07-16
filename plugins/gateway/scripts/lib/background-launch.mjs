// ---------------------------------------------------------------------------
// Transactional background-worker launch.
//
// The background task path used to spawn the detached worker BEFORE persisting
// the job's request, then persist "queued" unconditionally. Under the worker's
// stdio:"ignore", a worker that lost the race (no stored job yet) or threw
// before tracking died without a trace and the job stayed "queued" forever.
//
// This helper makes the launch transactional:
//   1. persist status:"starting" WITH the request, BEFORE the spawn;
//   2. spawn the worker (injectable for tests);
//   3. on success → "queued" with the child pid;
//   4. on a synchronous throw or an early child "error" event → "failed" with a
//      redacted errorMessage (best-effort; never throws again).
//
// Dependency-light: only leaf libs (state, tracked-jobs, redaction) so it can
// be imported and unit-tested without loading gateway-companion.mjs (whose
// module top-level runs main()).
// ---------------------------------------------------------------------------

import { upsertJob, writeJobFile } from "./state.mjs";
import { appendLogLine, nowIso } from "./tracked-jobs.mjs";
import { buildStructuredError } from "./redaction.mjs";

function persistFailed({ job, workspaceRoot, logFile, baseRecord, error, secrets }) {
  const structured = buildStructuredError(
    {
      message: error instanceof Error ? error.message : String(error),
      context: "background worker launch"
    },
    { secrets }
  );
  const errorMessage = structured.userMessage;
  const completedAt = nowIso();
  const failedRecord = {
    ...baseRecord,
    status: "failed",
    phase: "failed",
    pid: null,
    errorMessage,
    completedAt
  };
  // Best-effort: a failed launch must never throw a second error on top.
  try {
    writeJobFile(workspaceRoot, job.id, failedRecord);
  } catch {
    /* job file may be unwritable — index update below still surfaces the failure */
  }
  try {
    upsertJob(workspaceRoot, { id: job.id, status: "failed", phase: "failed", pid: null, errorMessage, completedAt });
  } catch {
    /* best-effort */
  }
  try {
    appendLogLine(logFile, `Failed to launch worker: ${errorMessage}`);
  } catch {
    /* best-effort */
  }
  return { status: "failed", record: failedRecord, errorMessage, error };
}

/**
 * Launch the detached background worker transactionally.
 *
 * @param {{job: object, workspaceRoot: string, request: object, logFile: string|null}} ctx
 * @param {{spawnFn: (jobId: string, request: object) => {pid?: number|null, on?: Function},
 *          secrets?: string[]}} deps
 *   `spawnFn` receives the job id + request and returns the spawned child (or a
 *   test double). It may throw synchronously; that is caught and marked failed.
 * @returns {{status: "queued"|"failed", record: object, child?: object,
 *            errorMessage?: string, error?: Error}}
 */
export function launchBackgroundTaskWorker({ job, workspaceRoot, request, logFile }, { spawnFn, secrets = [] } = {}) {
  if (typeof spawnFn !== "function") {
    throw new Error("launchBackgroundTaskWorker requires a spawnFn.");
  }

  // 1. Persist the job WITH its request, marked "starting", BEFORE the spawn so
  //    the worker can never lose the race and read a not-yet-written job.
  const startingRecord = {
    ...job,
    status: "starting",
    phase: "starting",
    pid: null,
    logFile,
    request
  };
  writeJobFile(workspaceRoot, job.id, startingRecord);
  upsertJob(workspaceRoot, startingRecord);

  // 2. Spawn. A synchronous throw (e.g. EMFILE) marks the job failed.
  let child;
  try {
    child = spawnFn(job.id, request);
  } catch (error) {
    return persistFailed({ job, workspaceRoot, logFile, baseRecord: startingRecord, error, secrets });
  }

  // 3. Spawn succeeded → queued with the child pid.
  const queuedRecord = {
    ...startingRecord,
    status: "queued",
    phase: "queued",
    pid: child?.pid ?? null
  };
  writeJobFile(workspaceRoot, job.id, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);

  // 4. Best-effort guard for an early async "error" event (e.g. spawn ENOENT).
  //    The parent usually exits before this fires (the child is unref'd); the
  //    real safety net for a worker that dies before writing "running" is the
  //    stale-job reconciliation on `status`. This just catches the rare case
  //    where the parent is still alive when the event arrives.
  if (child && typeof child.on === "function") {
    child.on("error", (error) => {
      persistFailed({ job, workspaceRoot, logFile, baseRecord: queuedRecord, error, secrets });
    });
  }

  return { status: "queued", record: queuedRecord, child };
}
