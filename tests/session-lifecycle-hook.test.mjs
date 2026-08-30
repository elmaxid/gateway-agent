import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { upsertJob, loadState } from "../plugins/gateway/scripts/lib/state.mjs";
import { resolveWorkspaceRoot } from "../plugins/gateway/scripts/lib/workspace.mjs";
import { cleanupRunningJobs } from "../plugins/gateway/scripts/session-lifecycle-hook.mjs";
import { buildSingleJobSnapshot, resolveResultJob } from "../plugins/gateway/scripts/lib/job-control.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, "../plugins/gateway/scripts/session-lifecycle-hook.mjs");

function runHook(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [HOOK, "SessionStart"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Hook exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

describe("session-lifecycle-hook", () => {
  let tmpDir;
  let envFile;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-hook-test-"));
    envFile = path.join(tmpDir, "claude.env");
    fs.writeFileSync(envFile, "");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes GATEWAY_TRANSCRIPT_PATH to CLAUDE_ENV_FILE on SessionStart", async () => {
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-123",
      transcript_path: "/root/.claude/projects/foo/bar.jsonl"
    });

    await runHook(input, {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      GATEWAY_PLUGIN_CONFIG_DIR: tmpDir
    });

    const written = fs.readFileSync(envFile, "utf8");
    assert.ok(
      written.includes("GATEWAY_TRANSCRIPT_PATH"),
      `Expected GATEWAY_TRANSCRIPT_PATH in env file, got:\n${written}`
    );
    assert.ok(
      written.includes("/root/.claude/projects/foo/bar.jsonl"),
      `Expected transcript path value in env file, got:\n${written}`
    );
  });

  it("does not write GATEWAY_TRANSCRIPT_PATH when transcript_path is absent", async () => {
    const cleanEnvFile = path.join(tmpDir, "claude-no-transcript.env");
    fs.writeFileSync(cleanEnvFile, "");

    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-456"
      // no transcript_path
    });

    await runHook(input, {
      ...process.env,
      CLAUDE_ENV_FILE: cleanEnvFile,
      GATEWAY_PLUGIN_CONFIG_DIR: tmpDir
    });

    const written = fs.readFileSync(cleanEnvFile, "utf8");
    assert.ok(
      !written.includes("GATEWAY_TRANSCRIPT_PATH"),
      `Expected no GATEWAY_TRANSCRIPT_PATH in env file when path absent, got:\n${written}`
    );
  });

  it("emits an additionalContext routing index derived from pick-tool, excluding model-invocation-disabled commands", async () => {
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-789"
    });

    const stdout = await runHook(input, {
      ...process.env,
      CLAUDE_ENV_FILE: path.join(tmpDir, "claude-routing.env"),
      GATEWAY_PLUGIN_CONFIG_DIR: tmpDir
    });

    const output = JSON.parse(stdout);
    const ctx = output.hookSpecificOutput.additionalContext;
    assert.match(ctx, /Skill\(gateway:spec-plan\)/, `Expected a real pick-tool entry in additionalContext, got:\n${ctx}`);
    assert.doesNotMatch(ctx, /\/gateway:status/, `Expected model-invocation-disabled commands excluded, got:\n${ctx}`);
  });
});

// Task 22/23: maintainer decision — background jobs SURVIVE session end
// (they're spawned detached specifically so they can). cleanupRunningJobs
// must not terminate a still-running/queued job, and must not remove it
// from the index either -- both would make the job unreachable/unrecoverable
// even though its worker process is fine.
describe("cleanupRunningJobs -- survive-session-end policy (Task 22/23)", () => {
  function withTempState(fn) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-hook-survive-data-"));
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-hook-survive-ws-"));
    const prev = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    const workspaceRoot = resolveWorkspaceRoot(wsDir);
    try {
      return fn({ dataDir, workspaceRoot });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = prev;
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  }

  it("does not terminate a still-running job's real process", () => {
    withTempState(({ workspaceRoot }) => {
      // A real, genuinely alive detached process -- proves cleanupRunningJobs
      // never signals it, not just that it "forgets" to update a status field.
      const longLived = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
      try {
        upsertJob(workspaceRoot, {
          id: "survivor-job", kind: "task", jobClass: "task", title: "t", workspaceRoot,
          sessionId: "sess-survive", status: "running", pid: longLived.pid,
        });

        cleanupRunningJobs(workspaceRoot, workspaceRoot, null, "sess-survive");

        assert.doesNotThrow(() => process.kill(longLived.pid, 0), "the job's real process must still be alive");
      } finally {
        longLived.kill("SIGKILL");
      }
    });
  });

  it("does not remove a running or queued job from the index", () => {
    withTempState(({ workspaceRoot }) => {
      upsertJob(workspaceRoot, {
        id: "running-job", kind: "task", jobClass: "task", title: "t", workspaceRoot,
        sessionId: "sess-survive-2", status: "running", pid: 999999,
      });
      upsertJob(workspaceRoot, {
        id: "queued-job", kind: "task", jobClass: "task", title: "t", workspaceRoot,
        sessionId: "sess-survive-2", status: "queued", pid: null,
      });

      cleanupRunningJobs(workspaceRoot, workspaceRoot, null, "sess-survive-2");

      const state = loadState(workspaceRoot);
      const running = state.jobs.find((j) => j.id === "running-job");
      const queued = state.jobs.find((j) => j.id === "queued-job");
      assert.ok(running, "running job must still be in the index");
      assert.equal(running.status, "running", "status must be untouched");
      assert.ok(queued, "queued job must still be in the index");
      assert.equal(queued.status, "queued", "status must be untouched");
    });
  });

  it("leaves jobs from OTHER sessions and already-terminal jobs alone too", () => {
    withTempState(({ workspaceRoot }) => {
      upsertJob(workspaceRoot, {
        id: "other-session-job", kind: "task", jobClass: "task", title: "t", workspaceRoot,
        sessionId: "sess-other", status: "running", pid: 999999,
      });
      upsertJob(workspaceRoot, {
        id: "already-done", kind: "task", jobClass: "task", title: "t", workspaceRoot,
        sessionId: "sess-survive-3", status: "completed", pid: null,
      });

      cleanupRunningJobs(workspaceRoot, workspaceRoot, null, "sess-survive-3");

      const state = loadState(workspaceRoot);
      assert.equal(state.jobs.find((j) => j.id === "other-session-job")?.status, "running");
      assert.equal(state.jobs.find((j) => j.id === "already-done")?.status, "completed");
    });
  });

  it("a job left running past session end is still reported correctly once it completes naturally", () => {
    withTempState(({ workspaceRoot }) => {
      upsertJob(workspaceRoot, {
        id: "finishes-later", kind: "task", jobClass: "task", title: "t", workspaceRoot,
        sessionId: "sess-survive-4", status: "running", pid: 999999,
      });

      cleanupRunningJobs(workspaceRoot, workspaceRoot, null, "sess-survive-4");

      // Simulate the worker finishing normally, same as it would with no
      // session-end event involved at all.
      upsertJob(workspaceRoot, { id: "finishes-later", status: "completed", pid: null, completedAt: new Date().toISOString() });

      const snapshot = buildSingleJobSnapshot(workspaceRoot, "finishes-later");
      assert.equal(snapshot.job.status, "completed");

      const resultJob = resolveResultJob(workspaceRoot, "finishes-later");
      assert.equal(resultJob.job.status, "completed");
    });
  });
});
