#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadState, resolveStateFile } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { buildRoutingContext } from "./lib/routing-index.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
export const TRANSCRIPT_PATH_ENV = "GATEWAY_TRANSCRIPT_PATH";

async function readHookInput() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => {
      const trimmed = raw.trim();
      if (!trimmed) { resolve({}); return; }
      try { resolve(JSON.parse(trimmed)); }
      catch (err) { reject(new Error(`Failed to parse hook input: ${err.message}`)); }
    });
  });
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return Promise.resolve();
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return Promise.resolve();
  }

  return cleanupRunningJobs(cwd, workspaceRoot, stateFile, sessionId);
}

// Policy (Task 22, maintainer decision): background jobs SURVIVE session
// end. They're spawned detached specifically so they can keep running
// independently of the CLI session that launched them — killing them here
// would defeat that. If a job's worker legitimately dies on its own
// (crashes, gets orphaned), reconcileStaleJobs (job-control.mjs) already
// catches that consistently on every read path (`status`, `status <id>`,
// `result <id>`) by checking pid liveness, patching both the index and the
// job's own file together — session end doesn't need its own separate
// mechanism for that.
export function cleanupRunningJobs(cwd, workspaceRoot, stateFile, sessionId) {
  const state = loadState(workspaceRoot);
  const stillRunningCount = state.jobs.filter(
    (job) => job.sessionId === sessionId && (job.status === "queued" || job.status === "running")
  ).length;
  if (stillRunningCount > 0) {
    process.stderr.write(
      `[gateway] ${stillRunningCount} background job(s) from this session are still running and will keep going — check with /gateway:status.\n`
    );
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildRoutingContext()
    }
  }) + "\n");
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  return cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = await readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

// Only auto-run when executed directly (as the CLI hook Claude Code spawns).
// Without this guard, importing this module's named exports for direct
// in-process testing would also trigger main(), which reads stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`[gateway] session-lifecycle-hook error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
