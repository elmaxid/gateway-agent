#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTreeAsync } from "./lib/process.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
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

async function cleanupRunningJobs(cwd, workspaceRoot, stateFile, sessionId) {
  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return;
  }

  const failedToTerminate = new Set();
  for (const job of sessionJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      await terminateProcessTreeAsync(job.pid ?? Number.NaN);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[gateway] Warning: failed to terminate job ${job.id} (pid ${job.pid}): ${message}\n`);
      failedToTerminate.add(job.id);
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs
      .filter((job) => job.sessionId !== sessionId || failedToTerminate.has(job.id))
      .map((job) =>
        failedToTerminate.has(job.id) ? { ...job, status: "failed" } : job
      )
  });
}

const GATEWAY_ROUTING_CONTEXT = `<gateway-routing-rules>
Gateway plugin active. Prefer these tools for delegation to alternative LLMs:
- Code review before commit → /gateway:review --include-diff
- Multi-model debate / architecture decision → /gateway:debate --include-diff
- Adversarial 2-pass review → /gateway:adversarial-review --include-diff
- Feature implementation → gateway:gateway-coder
- Bug investigation → gateway:gateway-debugger
- Codebase exploration → gateway:gateway-researcher
Run /gateway:setup to see configured profiles and endpoints.
</gateway-routing-rules>`;

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: GATEWAY_ROUTING_CONTEXT
    }
  }) + "\n");
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  return cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((err) => {
  process.stderr.write(`[gateway] session-lifecycle-hook error: ${err.message}\n`);
  process.exitCode = 1;
});
