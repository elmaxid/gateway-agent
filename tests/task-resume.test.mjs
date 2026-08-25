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

import { upsertJob } from "../plugins/gateway/scripts/lib/state.mjs";

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
