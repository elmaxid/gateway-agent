// Task 26 — `task --resume <jobRef>` wiring. Negative paths (all reject
// BEFORE any harness subprocess spawns, so no real codex/kimi/network needed)
// plus one end-to-end positive path via a fake codex binary that proves the
// full chain: job lookup -> continuationRef extraction -> capability check ->
// actual spawn args.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listJobs, upsertJob, writeJobFile } from "../plugins/gateway/scripts/lib/state.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");
const NODE_BIN_DIR = path.dirname(process.execPath);

const savedEnv = { ...process.env };
after(() => {
  process.env = savedEnv;
});

function makeFixture() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-resume-config-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-resume-data-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gw-resume-ws-"));

  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      profiles: {
        good: { kind: "claude-gateway", baseUrl: "http://127.0.0.1:1", defaultModel: "m" },
        // A second, DISTINCT profile -- lets tests prove profile inheritance
        // actually picks the source job's profile, not whatever the current
        // default happens to be (which is deliberately "stale" by default so
        // a silent leak toward it would be caught).
        stale: { kind: "claude-gateway", baseUrl: "http://127.0.0.1:2", defaultModel: "m" },
        // A profile whose default model is DISTINCT from every other one here,
        // so "recorded the profile's configured model" cannot pass by accident
        // (task B1 tests below).
        modelled: { kind: "claude-gateway", baseUrl: "http://127.0.0.1:3", defaultModel: "profile-default-model" },
      },
      defaultProfile: "stale",
      reviewProfile: null,
      taskProfile: "stale",
    }, null, 2)
  );

  return { configDir, dataDir, workspaceRoot };
}

function cleanupFixture(fx) {
  for (const dir of [fx.configDir, fx.dataDir, fx.workspaceRoot]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedJob(fx, patch) {
  const prevDataEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fx.dataDir;
  try {
    upsertJob(fx.workspaceRoot, {
      id: "job-resume-src",
      kind: "task",
      jobClass: "task",
      title: "Gateway Task",
      workspaceRoot: fx.workspaceRoot,
      status: "completed",
      harness: "codex",
      write: true,
      profileName: "good",
      continuationRef: "thread-abc-123",
      continuationCwd: fx.workspaceRoot,
      ...patch,
    });
  } finally {
    if (prevDataEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevDataEnv;
  }
}

function runTask(fx, args) {
  return execFileAsync(process.execPath, [COMPANION, "task", "--cwd", fx.workspaceRoot, ...args], {
    timeout: 8000,
    env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: fx.configDir, CLAUDE_PLUGIN_DATA: fx.dataDir },
  });
}

describe("task --resume: rejects before spawning any harness", () => {
  it("unknown job reference -> exit 2, no job found", async () => {
    const fx = makeFixture();
    try {
      await runTask(fx, ["--resume", "does-not-exist", "hi"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `stderr: ${err.stderr}`);
      assert.match(err.stderr, /no (finished |)job found/i);
    } finally {
      cleanupFixture(fx);
    }
  });

  it("source job not completed -> exit 2, names the status", async () => {
    const fx = makeFixture();
    seedJob(fx, { status: "failed", continuationRef: null });
    try {
      await runTask(fx, ["--resume", "job-resume-src", "hi"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `stderr: ${err.stderr}`);
      assert.match(err.stderr, /did not complete successfully/i);
      assert.match(err.stderr, /failed/);
    } finally {
      cleanupFixture(fx);
    }
  });

  it("source job has no continuation reference -> exit 2", async () => {
    const fx = makeFixture();
    seedJob(fx, { continuationRef: null });
    try {
      await runTask(fx, ["--resume", "job-resume-src", "hi"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `stderr: ${err.stderr}`);
      assert.match(err.stderr, /no continuation reference/i);
    } finally {
      cleanupFixture(fx);
    }
  });

  // Task 18/25: zero has no verified resume mechanism at all -- even a
  // (hand-crafted, unrealistic) continuationRef on a zero job must still be
  // rejected by the capability check, never reach the harness.
  it("harness with resume unsupported (zero) -> exit 2, never spawns", async () => {
    const fx = makeFixture();
    seedJob(fx, { harness: "zero", continuationRef: "whatever" });
    try {
      await runTask(fx, ["--resume", "job-resume-src", "hi"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `stderr: ${err.stderr}`);
      assert.match(err.stderr, /does not support --resume/i);
    } finally {
      cleanupFixture(fx);
    }
  });

  // Arbiter finding (2026-08-25): --profile was re-resolved with no
  // reference to the source job -- a resume with a different --profile
  // would silently continue that session against a different gateway
  // endpoint/credentials than turn 1 used.
  it("explicit --profile conflicting with the source job's profile -> exit 2", async () => {
    const fx = makeFixture();
    seedJob(fx, { profileName: "good" });
    try {
      await runTask(fx, ["--resume", "job-resume-src", "--profile", "stale", "hi"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `stderr: ${err.stderr}`);
      assert.match(err.stderr, /originally run with profile "good"/);
    } finally {
      cleanupFixture(fx);
    }
  });

  it("explicit --harness conflicting with the source job's harness -> exit 2", async () => {
    const fx = makeFixture();
    seedJob(fx, { harness: "codex" });
    try {
      await runTask(fx, ["--resume", "job-resume-src", "--harness", "kimi", "hi"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `stderr: ${err.stderr}`);
      assert.match(err.stderr, /captured on harness "codex"/);
    } finally {
      cleanupFixture(fx);
    }
  });

  // Task 25: kimi sessions are verified bound to their originating cwd --
  // caught here before spending a real request, not left for kimi's own CLI
  // to reject after the fact.
  // Cross-review finding: the strict CLI parser (args.mjs) rejects a MISSING
  // value for --resume, but allows an explicit EMPTY one through
  // (--resume=). Without this check that silently skips the whole resume
  // block and runs a fresh task with no warning -- the user believes they
  // resumed and didn't.
  it("--resume= (explicit empty value) -> exit 2, never silently starts a fresh task", async () => {
    const fx = makeFixture();
    try {
      await runTask(fx, ["--resume=", "hi"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `stderr: ${err.stderr}`);
      assert.match(err.stderr, /--resume requires a job id/i);
    } finally {
      cleanupFixture(fx);
    }
  });

  // Cross-review finding: continuationCwd/cwd are compared with path.resolve
  // output, which does not resolve symlinks -- a job started via a symlinked
  // --cwd and resumed from the real path must not false-positive as "a
  // different directory".
  it("kimi job resumed via a symlink to the same original cwd -> not rejected as a cwd mismatch", async () => {
    const fx = makeFixture();
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "gw-resume-real-"));
    const link = path.join(os.tmpdir(), `gw-resume-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(real, link);
    seedJob(fx, { harness: "kimi", continuationRef: "session_x", continuationCwd: link });
    try {
      // Resume from the REAL path while the job recorded the symlink -- must
      // be treated as the same directory, not rejected.
      await runTask(fx, ["--resume", "job-resume-src", "--cwd", real, "hi"]);
      assert.fail("should have thrown (no kimi CLI on PATH) -- but NOT with a cwd-mismatch message");
    } catch (err) {
      assert.doesNotMatch(err.stderr, /original working directory/i, `expected no cwd-mismatch rejection, got: ${err.stderr}`);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
      cleanupFixture(fx);
    }
  });

  // Cross-review finding (gpt-5.6-terra) + LIVE verification: neither
  // omitting a sandbox flag nor an explicit `-c sandbox_mode="read-only"`
  // override actually restricts a resumed codex turn (verified: it still
  // wrote a file to disk, exit 0, no denial anywhere in the stream) --
  // codex resume is ALWAYS effectively write-capable. --no-write on a codex
  // --resume must therefore be refused outright, not silently mislabeled.
  it("explicit --no-write on a codex resume -> exit 2 (codex resume cannot be forced read-only, verified)", async () => {
    const fx = makeFixture();
    seedJob(fx, { write: true });
    try {
      await runTask(fx, ["--resume", "job-resume-src", "--no-write", "hi"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `stderr: ${err.stderr}`);
      assert.match(err.stderr, /cannot be resumed read-only/i);
    } finally {
      cleanupFixture(fx);
    }
  });

  // Same rule applies even without an explicit flag: a codex job that was
  // itself originally read-only can never be honestly resumed read-only
  // either, since resume doesn't preserve (or accept an override of) the
  // sandbox mode -- inheriting write:false would repeat the exact
  // misrepresentation this whole check exists to prevent.
  it("codex job that was originally read-only -> exit 2 on resume, even with no --write/--no-write flag", async () => {
    const fx = makeFixture();
    seedJob(fx, { write: false });
    try {
      await runTask(fx, ["--resume", "job-resume-src", "hi"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `stderr: ${err.stderr}`);
      assert.match(err.stderr, /cannot be resumed read-only/i);
    } finally {
      cleanupFixture(fx);
    }
  });

  it("kimi job resumed from a different cwd -> exit 2, names the original cwd", async () => {
    const fx = makeFixture();
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gw-resume-other-"));
    seedJob(fx, { harness: "kimi", continuationRef: "session_x", continuationCwd: otherCwd });
    try {
      await runTask(fx, ["--resume", "job-resume-src", "hi"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `stderr: ${err.stderr}`);
      assert.match(err.stderr, /original working directory/i);
      assert.ok(err.stderr.includes(otherCwd), `expected the original cwd named, got: ${err.stderr}`);
    } finally {
      fs.rmSync(otherCwd, { recursive: true, force: true });
      cleanupFixture(fx);
    }
  });
});

describe("task --resume: end-to-end wiring via a fake codex binary", () => {
  function writeFakeCodex(dir) {
    const bin = path.join(dir, "codex");
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 0.0.0-fake\\n"); process.exit(0); }
let buf = "";
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  if (args[0] === "exec" && args[1] === "resume") {
    // Echo the resume args back as the agent_message so the test can assert
    // on them without needing a second parse path.
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: args[2] }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "RESUMED:" + JSON.stringify(args) } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\\n") + "\\n";
    process.stdout.write(lines, () => process.exit(0));
    return;
  }
  process.stdout.write("should not reach a fresh (non-resume) run in this test\\n");
  process.exit(1);
});
`;
    fs.writeFileSync(bin, script);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  // Arbiter finding: no --profile flag at all -- config's default profile is
  // deliberately "stale" (a different baseUrl) in this fixture, proving the
  // resumed call routes through the SOURCE job's profile ("good"), not
  // whatever the current default happens to be.
  it("no --profile given: inherits the source job's profile, not the current default", async () => {
    const fx = makeFixture();
    seedJob(fx, { harness: "codex", continuationRef: "thread-abc-123", profileName: "good" });
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fake-resume-profile-"));
    writeFakeCodex(fakeDir);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [COMPANION, "task", "--cwd", fx.workspaceRoot, "--resume", "job-resume-src", "--harness", "codex", "what did I say?"],
        {
          timeout: 8000,
          env: {
            ...process.env,
            GATEWAY_PLUGIN_CONFIG_DIR: fx.configDir,
            CLAUDE_PLUGIN_DATA: fx.dataDir,
            PATH: [fakeDir, NODE_BIN_DIR, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
          },
        }
      );
      assert.match(stdout, /127\.0\.0\.1:1/, `expected the "good" profile's baseUrl (127.0.0.1:1), got: ${stdout}`);
      assert.doesNotMatch(stdout, /127\.0\.0\.1:2/, `must NOT leak the current default "stale" profile's baseUrl, got: ${stdout}`);
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true });
      cleanupFixture(fx);
    }
  });

  it("resolves the source job, passes resumeRef through, and codex is invoked with exec resume <ref> --json", async () => {
    const fx = makeFixture();
    seedJob(fx, { harness: "codex", continuationRef: "thread-abc-123" });
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fake-resume-"));
    writeFakeCodex(fakeDir);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [COMPANION, "task", "--cwd", fx.workspaceRoot, "--resume", "job-resume-src", "--harness", "codex", "what did I say?"],
        {
          timeout: 8000,
          env: {
            ...process.env,
            GATEWAY_PLUGIN_CONFIG_DIR: fx.configDir,
            CLAUDE_PLUGIN_DATA: fx.dataDir,
            PATH: [fakeDir, NODE_BIN_DIR, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
          },
        }
      );
      assert.match(stdout, /RESUMED:/);
      assert.match(stdout, /"exec","resume","thread-abc-123","--json"/);
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true });
      cleanupFixture(fx);
    }
  });

  // Positive path for the write-mode policy: a codex job that was originally
  // write:true (the fixture default) resumes with no --write/--no-write flag
  // at all and reaches codex normally -- the rejection is specific to an
  // effective write:false, not to --resume itself.
  it("resuming a write:true source job with no --write/--no-write flag -> reaches codex normally", async () => {
    const fx = makeFixture();
    seedJob(fx, { harness: "codex", continuationRef: "thread-abc-123", write: true });
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fake-resume-inherit-"));
    writeFakeCodex(fakeDir);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [COMPANION, "task", "--cwd", fx.workspaceRoot, "--resume", "job-resume-src", "--harness", "codex", "what did I say?"],
        {
          timeout: 8000,
          env: {
            ...process.env,
            GATEWAY_PLUGIN_CONFIG_DIR: fx.configDir,
            CLAUDE_PLUGIN_DATA: fx.dataDir,
            PATH: [fakeDir, NODE_BIN_DIR, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
          },
        }
      );
      assert.match(stdout, /RESUMED:/);
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true });
      cleanupFixture(fx);
    }
  });
});

// ---------------------------------------------------------------------------
// Task B1 (prewalk plan): the job record persists the model that ACTUALLY ran.
// Before this, no job class recorded it, so attributing a finished run to a
// model meant re-reading the profile's CURRENT default -- which changes, and
// which is wrong the moment a run used --model or a resumed turn swapped it.
// Same fake-codex pattern as the resume tests above: no network, no real model.
// ---------------------------------------------------------------------------
describe("task: persists the model that actually ran (B1)", () => {
  // Answers both a fresh `exec` and an `exec resume`, with a fixed final
  // message -- these tests assert on the persisted record, not on args.
  function writeFakeCodexAnyMode(dir) {
    const bin = path.join(dir, "codex");
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 0.0.0-fake\\n"); process.exit(0); }
let buf = "";
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-fake" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "FAKE OUTPUT" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\\n") + "\\n";
  process.stdout.write(lines, () => process.exit(0));
});
`;
    fs.writeFileSync(bin, script);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  async function runCompanion(fx, args) {
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fake-model-"));
    writeFakeCodexAnyMode(fakeDir);
    try {
      return await execFileAsync(process.execPath, [COMPANION, ...args], {
        timeout: 15000,
        env: {
          ...process.env,
          GATEWAY_PLUGIN_CONFIG_DIR: fx.configDir,
          CLAUDE_PLUGIN_DATA: fx.dataDir,
          PATH: [fakeDir, NODE_BIN_DIR, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
        },
      });
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true });
    }
  }

  function withDataDir(fx, fn) {
    const prev = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = fx.dataDir;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = prev;
    }
  }

  // The job the run under test created: anything that is not a seeded source job.
  function runJobRecord(fx) {
    return withDataDir(fx, () => listJobs(fx.workspaceRoot).find((j) => j.id !== "job-resume-src") ?? null);
  }

  function jobRecordById(fx, id) {
    return withDataDir(fx, () => listJobs(fx.workspaceRoot).find((j) => j.id === id) ?? null);
  }

  // The background path: `task --background` spawns a detached `task-worker`
  // that reads this stored request. Driving the worker directly exercises the
  // same code without depending on process detachment.
  function seedWorkerJob(fx, jobId, request) {
    withDataDir(fx, () => {
      const rec = {
        id: jobId,
        kind: "task",
        jobClass: "task",
        title: "Gateway Task",
        workspaceRoot: fx.workspaceRoot,
        status: "queued",
        phase: "queued",
        logFile: null,
        write: request.write !== false,
        request,
      };
      writeJobFile(fx.workspaceRoot, jobId, rec);
      upsertJob(fx.workspaceRoot, rec);
    });
  }

  it("foreground, no --model: records the profile's configured model, in state (human + JSON) and result", async () => {
    const fx = makeFixture();
    try {
      await runCompanion(fx, ["task", "--cwd", fx.workspaceRoot, "--harness", "codex", "--profile", "modelled", "hello"]);

      const job = runJobRecord(fx);
      assert.ok(job, "the run should have created a job record");
      assert.equal(job.model, "profile-default-model");

      const { stdout: humanStatus } = await runCompanion(fx, ["status", job.id, "--cwd", fx.workspaceRoot]);
      assert.match(humanStatus, /Model: profile-default-model/);

      const { stdout: jsonStatus } = await runCompanion(fx, ["status", job.id, "--cwd", fx.workspaceRoot, "--json"]);
      assert.equal(JSON.parse(jsonStatus).job.model, "profile-default-model");

      const { stdout: jsonResult } = await runCompanion(fx, ["result", job.id, "--cwd", fx.workspaceRoot, "--json"]);
      const parsedResult = JSON.parse(jsonResult);
      assert.equal(parsedResult.job.model, "profile-default-model");
      assert.equal(parsedResult.storedJob.model, "profile-default-model");
    } finally {
      cleanupFixture(fx);
    }
  });

  it("foreground with an explicit --model: records the override, not the profile default", async () => {
    const fx = makeFixture();
    try {
      await runCompanion(fx, [
        "task", "--cwd", fx.workspaceRoot, "--harness", "codex", "--profile", "modelled",
        "--model", "override-model", "hello",
      ]);
      const job = runJobRecord(fx);
      assert.equal(job.model, "override-model");
    } finally {
      cleanupFixture(fx);
    }
  });

  // The prewalk case: turn 2 resumes turn 1's session with a DIFFERENT model.
  // Recording the source job's model here would make the swap invisible --
  // which is the one thing this field exists to prove.
  it("foreground --resume: records the model of THAT turn, not the source job's", async () => {
    const fx = makeFixture();
    seedJob(fx, { model: "turn1-model" });
    try {
      await runCompanion(fx, [
        "task", "--cwd", fx.workspaceRoot, "--resume", "job-resume-src", "--harness", "codex",
        "--model", "turn2-model", "keep going",
      ]);
      const job = runJobRecord(fx);
      assert.equal(job.model, "turn2-model");
      // The source job's own record is untouched by the resume.
      assert.equal(jobRecordById(fx, "job-resume-src").model, "turn1-model");
    } finally {
      cleanupFixture(fx);
    }
  });

  it("background worker, no model in the stored request: records the profile's configured model", async () => {
    const fx = makeFixture();
    seedWorkerJob(fx, "job-bg-default", {
      cwd: fx.workspaceRoot, profile: "modelled", write: true, prompt: "hello", harness: "codex",
    });
    try {
      await runCompanion(fx, ["task-worker", "--cwd", fx.workspaceRoot, "--job-id", "job-bg-default"]);
      assert.equal(jobRecordById(fx, "job-bg-default").model, "profile-default-model");
    } finally {
      cleanupFixture(fx);
    }
  });

  it("background worker with an explicit model in the stored request: records the override", async () => {
    const fx = makeFixture();
    seedWorkerJob(fx, "job-bg-override", {
      cwd: fx.workspaceRoot, profile: "modelled", write: true, prompt: "hello", harness: "codex",
      model: "bg-override-model",
    });
    try {
      await runCompanion(fx, ["task-worker", "--cwd", fx.workspaceRoot, "--job-id", "job-bg-override"]);
      assert.equal(jobRecordById(fx, "job-bg-override").model, "bg-override-model");
    } finally {
      cleanupFixture(fx);
    }
  });

  it("background worker resuming a session: records the model of that turn", async () => {
    const fx = makeFixture();
    seedJob(fx, { model: "turn1-model" });
    seedWorkerJob(fx, "job-bg-resume", {
      cwd: fx.workspaceRoot, profile: "good", write: true, prompt: "keep going", harness: "codex",
      resume: true, resumeRef: "thread-abc-123", model: "bg-turn2-model",
    });
    try {
      await runCompanion(fx, ["task-worker", "--cwd", fx.workspaceRoot, "--job-id", "job-bg-resume"]);
      assert.equal(jobRecordById(fx, "job-bg-resume").model, "bg-turn2-model");
      assert.equal(jobRecordById(fx, "job-resume-src").model, "turn1-model");
    } finally {
      cleanupFixture(fx);
    }
  });

  // The task's human output is the model's output verbatim, and flows pipe it
  // elsewhere -- the model belongs in the job record, never in this stream.
  it("a task's human output stays byte-identical: no model metadata added", async () => {
    const fx = makeFixture();
    try {
      const { stdout } = await runCompanion(fx, [
        "task", "--cwd", fx.workspaceRoot, "--harness", "codex", "--profile", "modelled",
        "--model", "override-model", "hello",
      ]);
      assert.equal(stdout, "FAKE OUTPUT\n");
    } finally {
      cleanupFixture(fx);
    }
  });

  // Task B2: the structured (--json) foreground result must carry the id of the
  // job it just created, so a caller can resume it without hunting the registry.
  it("foreground --json result includes the job id, which resolves in the registry", async () => {
    const fx = makeFixture();
    try {
      const { stdout } = await runCompanion(fx, [
        "task", "--cwd", fx.workspaceRoot, "--harness", "codex", "--profile", "modelled", "--json", "hello",
      ]);
      const parsed = JSON.parse(stdout);
      assert.equal(typeof parsed.jobId, "string");
      assert.ok(parsed.jobId.length > 0, "jobId should be non-empty");
      // The returned id resolves unambiguously against the job registry.
      assert.equal(jobRecordById(fx, parsed.jobId)?.id, parsed.jobId);
    } finally {
      cleanupFixture(fx);
    }
  });

  // A job recorded before this field existed simply has no model. Reads must
  // work and the model line must be absent -- never invented, never "unknown".
  it("a job record predating this field reads fine and shows no model line", async () => {
    const fx = makeFixture();
    seedJob(fx, {});
    try {
      const { stdout: human } = await runCompanion(fx, ["status", "job-resume-src", "--cwd", fx.workspaceRoot]);
      assert.match(human, /job-resume-src/);
      assert.doesNotMatch(human, /Model:/);

      const { stdout: json } = await runCompanion(fx, ["status", "job-resume-src", "--cwd", fx.workspaceRoot, "--json"]);
      assert.equal(JSON.parse(json).job.model, undefined);
    } finally {
      cleanupFixture(fx);
    }
  });

  // A FAILED run is exactly when "which model ran this?" matters most: it is
  // what tells you whether retrying with a different model is worth it. If the
  // failure path stops carrying the attribution, a failed job becomes
  // indistinguishable from one predating the field (the case asserted above),
  // and the only signal left is a log file nobody correlates.
  it("a failed run still records the model, harness and profile that ran it", async () => {
    const fx = makeFixture();
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fake-fail-"));
    const bin = path.join(fakeDir, "codex");
    fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 0.0.0-fake\\n"); process.exit(0); }
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-fake-fail" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "turn.failed", error: { message: "fake harness failure" } }),
  ].join("\\n") + "\\n";
  process.stdout.write(lines, () => process.exit(1));
});
`);
    fs.chmodSync(bin, 0o755);
    try {
      // The CLI exits non-zero on a failed task, which execFile surfaces as a
      // rejection — the failure IS the scenario under test, so capture the
      // rejection and assert on what it carried plus the persisted record.
      const failure = await execFileAsync(process.execPath, [
        COMPANION, "task", "--cwd", fx.workspaceRoot, "--harness", "codex", "--profile", "modelled", "--json", "hello",
      ], {
        timeout: 15000,
        env: {
          ...process.env,
          GATEWAY_PLUGIN_CONFIG_DIR: fx.configDir,
          CLAUDE_PLUGIN_DATA: fx.dataDir,
          PATH: [fakeDir, NODE_BIN_DIR, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
        },
      }).catch((err) => err);

      const job = runJobRecord(fx);
      assert.ok(job, "a failed run must still leave a job record");
      assert.equal(job.status, "failed");
      assert.equal(job.model, "profile-default-model");
      assert.equal(job.harness, "codex");
      assert.equal(job.profileName, "modelled");

      // The failure payload must carry the job id for the same reason the
      // success one does: reading the record back is precisely what a caller
      // does after a failure. Without it, finding the job means scanning the
      // registry for the newest entry — the guess this field removes.
      const payload = JSON.parse(failure.stdout);
      assert.equal(payload.status, "failed");
      assert.equal(payload.jobId, job.id);
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true });
      cleanupFixture(fx);
    }
  });
});
