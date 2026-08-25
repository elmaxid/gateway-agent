import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";
import { redactText, truncateOutput } from "./redaction.mjs";

export const SESSION_ID_ENV = "GATEWAY_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
  } catch (err) {
    process.stderr.write(`[gateway] Warning: failed to append to log ${logFile}: ${err.message}\n`);
  }
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
  } catch (err) {
    process.stderr.write(`[gateway] Warning: failed to append block to log ${logFile}: ${err.message}\n`);
  }
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  try {
    fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[gateway] Warning: failed to create log file ${logFile}: ${err.message}\n`);
    return logFile;
  }
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null, secrets = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  // Harness progress (message/stderr/logBody) can carry credentials and flows
  // straight into the job log — and from there into the `status` preview the
  // agent reads. Redact it before it is persisted/echoed. Redaction is opt-in:
  // background task paths pass a secrets array (even empty, which still scrubs
  // Bearer tokens, URL credentials, and query strings); foreground callers pass
  // nothing and keep byte-identical output.
  const scrub = Array.isArray(secrets) ? (text) => redactText(text, secrets) : (text) => text;

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = scrub(event.stderrMessage ?? event.message);
    if (stderr && stderrMessage) {
      process.stderr.write(`[gateway] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, scrub(event.message));
    appendLogBlock(logFile, event.logTitle, event.logBody == null ? event.logBody : scrub(event.logBody));
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      harness: execution.harness ?? null,
      profileName: execution.profileName ?? null,
      continuationRef: execution.continuationRef ?? null,
      continuationCwd: execution.continuationCwd ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      harness: execution.harness ?? null,
      profileName: execution.profileName ?? null,
      continuationRef: execution.continuationRef ?? null,
      continuationCwd: execution.continuationCwd ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    // A thrown provider error can carry a credentialed URL or key. This message
    // is persisted to the job file/index and surfaced agent-visible by `result`,
    // so redact+truncate it here — the redaction layer isn't otherwise on this
    // path. redactText with `secrets ?? []` still applies the Bearer/URL/query
    // rules even when no config secrets are threaded in.
    const rawMessage = error instanceof Error ? error.message : String(error);
    const errorMessage = truncateOutput(redactText(rawMessage, options.secrets ?? []));
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}
