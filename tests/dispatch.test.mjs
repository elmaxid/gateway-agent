import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Semaphore, normalizeBaseUrl } from "../plugins/gateway/scripts/lib/concurrency.mjs";
import {
  parsePlanFile,
  parseInlineTasks,
  parseAssignment,
  parseModelOverrides,
  buildTaskList
} from "../plugins/gateway/scripts/lib/dispatch.mjs";

describe("Semaphore", () => {
  it("allows up to max concurrent executions", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const task = () => sem.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 50));
      active--;
    });
    await Promise.all([task(), task(), task(), task()]);
    assert.equal(maxActive, 2);
  });

  it("run() returns the function result", async () => {
    const sem = new Semaphore(1);
    const result = await sem.run(async () => 42);
    assert.equal(result, 42);
  });

  it("run() releases on throw", async () => {
    const sem = new Semaphore(1);
    await assert.rejects(() => sem.run(() => { throw new Error("boom"); }), /boom/);
    const result = await sem.run(async () => "ok");
    assert.equal(result, "ok");
  });
});

describe("normalizeBaseUrl", () => {
  it("strips path and trailing slash", () => {
    assert.equal(normalizeBaseUrl("http://host:4000/v1/"), "http://host:4000");
  });

  it("returns input for invalid URLs", () => {
    assert.equal(normalizeBaseUrl("not-a-url"), "not-a-url");
  });
});

describe("parsePlanFile", () => {
  it("extracts tasks from ## Task N headers", () => {
    const content = [
      "# Plan",
      "",
      "## Task 1: Add retry logic",
      "Implement retry with exponential backoff.",
      "",
      "### Acceptance Criteria",
      "- Retries 3 times",
      "",
      "## Task 2: Fix auth",
      "Fix the token expiry check.",
    ].join("\n");
    const tasks = parsePlanFile(content);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, 1);
    assert.ok(tasks[0].prompt.includes("Implement retry"));
    assert.ok(tasks[0].prompt.includes("Retries 3 times"));
    assert.equal(tasks[1].id, 2);
    assert.ok(tasks[1].prompt.includes("Fix the token"));
  });

  it("ignores non-task ## headers", () => {
    const content = "## Overview\nStuff\n\n## Task 1: Only\nBody\n\n## Global Constraints\nMore stuff\n";
    const tasks = parsePlanFile(content);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 1);
  });

  it("matches case-insensitively and different separators", () => {
    const content = "## task 3 - Setup\nBody\n\n## Task 5 > Deploy\nBody2\n";
    const tasks = parsePlanFile(content);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, 3);
    assert.equal(tasks[1].id, 5);
  });

  it("matches bare ## Task N header with no separator", () => {
    const content = [
      "# Plan",
      "",
      "## Task 1",
      "",
      "Implement the thing.",
    ].join("\n");
    const tasks = parsePlanFile(content);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 1);
    assert.ok(tasks[0].prompt.includes("Implement the thing."));
  });

  it("throws on zero tasks", () => {
    assert.throws(() => parsePlanFile("## Overview\nNo tasks"), /No tasks found/);
  });

  it("throws on duplicate task IDs", () => {
    const content = "## Task 1: First\nA\n\n## Task 1: Dupe\nB\n";
    assert.throws(() => parsePlanFile(content), /Duplicate task ID/i);
  });
});

describe("parseInlineTasks", () => {
  it("splits on last colon for profile", () => {
    const tasks = parseInlineTasks(["Add retry to api-client.mjs:minimax"], null);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].prompt, "Add retry to api-client.mjs");
    assert.equal(tasks[0].profile, "minimax");
  });

  it("uses default profile when no colon", () => {
    const tasks = parseInlineTasks(["Fix auth bug"], "glm");
    assert.equal(tasks[0].profile, "glm");
    assert.equal(tasks[0].prompt, "Fix auth bug");
  });

  it("handles prompts containing URLs with colons", () => {
    const tasks = parseInlineTasks(["Fix http://example.com/api endpoint:minimax"], null);
    assert.equal(tasks[0].prompt, "Fix http://example.com/api endpoint");
    assert.equal(tasks[0].profile, "minimax");
  });

  it("numbers tasks sequentially from 1", () => {
    const tasks = parseInlineTasks(["A:x", "B:y", "C:z"], null);
    assert.deepEqual(tasks.map((t) => t.id), [1, 2, 3]);
  });
});

describe("parseAssignment", () => {
  const sequential = [1, 2, 3, 4, 5, 6];

  it("parses inclusive ranges", () => {
    const map = parseAssignment("1-3:minimax,4-6:glm", sequential);
    assert.equal(map.get(1), "minimax");
    assert.equal(map.get(3), "minimax");
    assert.equal(map.get(4), "glm");
    assert.equal(map.get(6), "glm");
  });

  it("parses single-ID assignment", () => {
    const map = parseAssignment("4:glm", sequential);
    assert.equal(map.get(4), "glm");
    assert.equal(map.has(1), false);
  });

  it("throws on overlapping ranges", () => {
    assert.throws(() => parseAssignment("1-3:a,2-4:b", sequential), /overlap/i);
  });

  it("throws on out-of-bounds range", () => {
    assert.throws(() => parseAssignment("1-10:a", sequential), /does not exist in the plan/i);
  });

  it("throws on invalid range (start > end)", () => {
    assert.throws(() => parseAssignment("5-3:a", sequential), /Invalid range/i);
  });

  it("rejects empty --assign string", () => {
    assert.throws(() => parseAssignment("", sequential), /no puede estar vacío/i);
    assert.throws(() => parseAssignment("   ", sequential), /no puede estar vacío/i);
  });

  it("accepts assignment for a real non-sequential task ID", () => {
    const map = parseAssignment("3:glm", [1, 3]);
    assert.equal(map.get(3), "glm");
    assert.equal(map.has(1), false);
  });

  it("rejects assignment for an ID absent from a non-sequential plan", () => {
    assert.throws(() => parseAssignment("2:glm", [1, 3]), /does not exist in the plan/i);
  });

  it("rejects a range spanning a gap in non-sequential IDs", () => {
    assert.throws(() => parseAssignment("1-3:glm", [1, 3]), /does not exist in the plan/i);
  });
});

describe("parseModelOverrides", () => {
  it("parses profile:model pairs", () => {
    const map = parseModelOverrides(["minimax:minimax-m3", "glm:glm-5.2"]);
    assert.equal(map.get("minimax"), "minimax-m3");
    assert.equal(map.get("glm"), "glm-5.2");
  });

  it("returns empty map for empty input", () => {
    const map = parseModelOverrides([]);
    assert.equal(map.size, 0);
  });
});

describe("buildTaskList", () => {
  it("applies assignment and model overrides", () => {
    const raw = [
      { id: 1, prompt: "A" },
      { id: 2, prompt: "B" },
    ];
    const assignment = new Map([[1, "minimax"], [2, "glm"]]);
    const overrides = new Map([["minimax", "minimax-m3"]]);
    const tasks = buildTaskList(raw, assignment, overrides, "default-profile");
    assert.equal(tasks[0].profile, "minimax");
    assert.equal(tasks[0].model, "minimax-m3");
    assert.equal(tasks[1].profile, "glm");
    assert.equal(tasks[1].model, null);
  });

  it("falls back to defaultProfile for unassigned tasks", () => {
    const raw = [{ id: 1, prompt: "A" }];
    const tasks = buildTaskList(raw, null, null, "fallback");
    assert.equal(tasks[0].profile, "fallback");
  });
});

// ---------------------------------------------------------------------------
// Execution engine tests
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync as fsChmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorktree,
  removeWorktree,
  collectPatch,
  ensureDispatchGitignore,
  cleanOrphanedWorktrees,
} from "../plugins/gateway/scripts/lib/dispatch.mjs";

function createTempGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "file.txt"), "original\n");
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

function headSha(repo) {
  const head = readFileSync(path.join(repo, ".git", "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5).trim();
  try { return readFileSync(path.join(repo, ".git", ref), "utf8").trim(); } catch {}
  try {
    const packed = readFileSync(path.join(repo, ".git", "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      const m = line.match(/^(\S+)\s+" + ref + "$/);
      if (m) return m[1];
    }
  } catch {}
  throw new Error("could not resolve HEAD sha for " + repo);
}

describe("createWorktree", () => {
  it("creates a detached worktree at the specified path", () => {
    const repo = createTempGitRepo();
    try {
      const baseSha = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
      const wtPath = path.join(repo, ".gateway-dispatch", "test-job", "worktrees", "task-1");
      createWorktree(repo, wtPath, baseSha);
      assert.ok(existsSync(path.join(wtPath, "file.txt")));
      removeWorktree(repo, wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("collectPatch", () => {
  it("returns patch content for modified files", () => {
    const repo = createTempGitRepo();
    try {
      const baseSha = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
      const wtPath = path.join(repo, ".gateway-dispatch", "test-job", "worktrees", "task-1");
      createWorktree(repo, wtPath, baseSha);
      writeFileSync(path.join(wtPath, "file.txt"), "modified\n");
      const patch = collectPatch(wtPath);
      // collectPatch must return a well-formed git diff (binary-capable), not just
      // any string containing the word "modified". Verifies the execFileSync-based
      // implementation still produces a correct patch after the refactor.
      assert.ok(patch.startsWith("diff --git a/file.txt b/file.txt"));
      assert.ok(patch.includes("-original"));
      assert.ok(patch.includes("+modified"));
      assert.ok(patch.length > 0);
      removeWorktree(repo, wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("captures untracked files via intent-to-add", () => {
    const repo = createTempGitRepo();
    try {
      const baseSha = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
      const wtPath = path.join(repo, ".gateway-dispatch", "test-job", "worktrees", "task-1");
      createWorktree(repo, wtPath, baseSha);
      writeFileSync(path.join(wtPath, "newfile.txt"), "new content\n");
      const patch = collectPatch(wtPath);
      assert.ok(patch.includes("newfile.txt"));
      removeWorktree(repo, wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns empty string when no changes", () => {
    const repo = createTempGitRepo();
    try {
      const baseSha = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
      const wtPath = path.join(repo, ".gateway-dispatch", "test-job", "worktrees", "task-1");
      createWorktree(repo, wtPath, baseSha);
      const patch = collectPatch(wtPath);
      assert.equal(patch, "");
      removeWorktree(repo, wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("ensureDispatchGitignore", () => {
  it("appends .gateway-dispatch/ to .git/info/exclude if missing", () => {
    const repo = createTempGitRepo();
    try {
      ensureDispatchGitignore(repo);
      const content = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
      assert.ok(content.includes(".gateway-dispatch/"));
      assert.ok(!existsSync(path.join(repo, ".gitignore")));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not duplicate if already present", () => {
    const repo = createTempGitRepo();
    try {
      const excludePath = path.join(repo, ".git", "info", "exclude");
      writeFileSync(excludePath, ".gateway-dispatch/\n");
      ensureDispatchGitignore(repo);
      const content = readFileSync(excludePath, "utf8");
      const count = content.split(".gateway-dispatch/").length - 1;
      assert.equal(count, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not duplicate if present without trailing slash", () => {
    const repo = createTempGitRepo();
    try {
      const excludePath = path.join(repo, ".git", "info", "exclude");
      writeFileSync(excludePath, ".gateway-dispatch\n");
      ensureDispatchGitignore(repo);
      const content = readFileSync(excludePath, "utf8");
      const count = (content.match(/^\.gateway-dispatch\/?\s*$/gm) || []).length;
      assert.equal(count, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not throw if .git/info/exclude cannot be written", () => {
    // Note: when run as root, chmod does not actually block root's own
    // writes, so this test only guarantees ensureDispatchGitignore never
    // throws — it can't force the failure branch to execute in every
    // environment. Mirrors the tolerance pattern used by the
    // "does not abort when .gateway-dispatch is unreadable" test above.
    const repo = createTempGitRepo();
    try {
      const infoDir = path.join(repo, ".git", "info");
      fsChmodSync(infoDir, 0o500);
      try {
        assert.doesNotThrow(() => ensureDispatchGitignore(repo));
      } finally {
        fsChmodSync(infoDir, 0o755);
      }
    } finally {
      try { fsChmodSync(path.join(repo, ".git", "info"), 0o755); } catch {}
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("runDispatch", () => {
  it("creates patches dir and writes manifest", async () => {
    const repo = createTempGitRepo();
    try {
      const { runDispatch } = await import("../plugins/gateway/scripts/lib/dispatch.mjs");
      const tasks = [{ id: 1, prompt: "noop", profile: "mock", model: "mock-model" }];

      const mockRunner = async (_profile, _prompt, _opts) => ({
        stdout: "done", stderr: "", exitCode: 0,
      });

      const result = await runDispatch(tasks, {
        cwd: repo,
        harness: "claude",
        write: true,
        maxConcurrency: 1,
        taskRunner: mockRunner,
        resolveProfileFn: () => ({ name: "mock", baseUrl: "http://localhost", defaultModel: "mock-model", kind: "claude-gateway" }),
        skipPreflight: true,
      });

      assert.equal(result.tasks.length, 1);
      assert.equal(result.tasks[0].status, "completed_no_changes");
      assert.ok(existsSync(path.join(repo, ".gateway-dispatch", result.jobId, "manifest.json")));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("failFast short-circuited tasks are counted (fail-loud, not silently dropped)", async () => {
    const repo = createTempGitRepo();
    try {
      const { runDispatch } = await import("../plugins/gateway/scripts/lib/dispatch.mjs");
      // maxConcurrency 1 on a shared baseUrl serializes tasks (FIFO semaphore):
      // task 1 fails -> failedCount>0 -> task 2 hits the failFast guard.
      const tasks = [
        { id: 1, prompt: "fail", profile: "mock", model: "mock-model" },
        { id: 2, prompt: "noop", profile: "mock", model: "mock-model" },
      ];

      const mockRunner = async (_profile, _prompt, _opts) => ({
        stdout: "", stderr: "boom", exitCode: 1,
      });

      const result = await runDispatch(tasks, {
        cwd: repo,
        harness: "claude",
        write: true,
        maxConcurrency: 1,
        failFast: true,
        taskRunner: mockRunner,
        resolveProfileFn: () => ({ name: "mock", baseUrl: "http://localhost", defaultModel: "mock-model", kind: "claude-gateway" }),
        skipPreflight: true,
      });

      // Both tasks must appear in the manifest — the aborted one must NOT be dropped.
      assert.equal(result.tasks.length, 2);
      // summary.failed must count the short-circuited task, or a downstream
      // exit-code consumer would see failed:0 and exit 0 despite real failures.
      assert.equal(result.summary.failed, 2);
      const t2 = result.tasks.find((t) => t.id === 2);
      assert.equal(t2.status, "failed");
      assert.equal(t2.error, "aborted");
      // model field present on the aborted TaskResult (shape consistency).
      assert.equal(t2.model, "mock-model");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("marks a task failed (error: timeout) when --timeout fires and the runner is killed", async () => {
    const repo = createTempGitRepo();
    try {
      const { runDispatch } = await import("../plugins/gateway/scripts/lib/dispatch.mjs");
      const tasks = [{ id: 1, prompt: "slow task", profile: "mock", model: "mock-model" }];

      // Exercises the real kill path (not a pre-built status:"failed" object):
      // the runner hangs until opts.signal aborts, then resolves with exitCode: null
      // — exactly what codex-harness.mjs / claude-subprocess.mjs return from
      // proc.on("exit", (code=null, sig)) when terminateProcessTree kills the child.
      const abortableRunner = (_profile, _prompt, opts) =>
        new Promise((resolve) => {
          const onAbort = () => resolve({ stdout: "partial output", stderr: "", exitCode: null, signal: "SIGTERM" });
          if (opts.signal?.aborted) return onAbort();
          opts.signal?.addEventListener("abort", onAbort, { once: true });
          // Never resolves on its own — the only exit is the timeout-driven abort.
        });

      const result = await runDispatch(tasks, {
        cwd: repo,
        harness: "claude",
        write: true,
        maxConcurrency: 1,
        timeoutMs: 100,
        taskRunner: abortableRunner,
        resolveProfileFn: () => ({ name: "mock", baseUrl: "http://localhost", defaultModel: "mock-model", kind: "claude-gateway" }),
      });

      const t1 = result.tasks.find((t) => t.id === 1);
      // Before the fix, `null ?? 0 === 0` fell through to collectPatch and reported
      // "completed_no_changes"; a timed-out task must be FAILED (timeout) instead.
      assert.equal(t1.status, "failed");
      assert.equal(t1.error, "timeout");
      assert.equal(t1.model, "mock-model");
      assert.equal(result.summary.failed, 1);
     assert.equal(result.summary.completed, 0);
     assert.equal(result.summary.completedNoChanges, 0);
   } finally {
     rmSync(repo, { recursive: true, force: true });
   }
 });

 it("SIGTERM reuses the signal handler, aborts the job and cleans worktrees without duplicate warnings", async () => {
   const repo = createTempGitRepo();
   try {
     const { runDispatch } = await import("../plugins/gateway/scripts/lib/dispatch.mjs");
     const tasks = [{ id: 1, prompt: "hang", profile: "mock", model: "mock-model" }];

      // Intercept process.on/removeListener for SIGINT/SIGTERM so we can fire the
      // registered handler directly (emitting a real signal would terminate the
      // test runner process). This also lets us assert both signals are handled.
      const registered = { SIGINT: 0, SIGTERM: 0 };
      const handlers = {};
      const origOn = process.on.bind(process);
      const origOff = process.removeListener.bind(process);
      process.on = (event, listener, ...rest) => {
        if (event === "SIGINT" || event === "SIGTERM") { registered[event]++; handlers[event] = listener; }
        return origOn(event, listener, ...rest);
      };
      process.removeListener = (event, listener, ...rest) => {
        if (event === "SIGINT" || event === "SIGTERM") handlers[event] = undefined;
        return origOff(event, listener, ...rest);
      };

      // Hangs until the abort signal fires; fires the captured SIGTERM handler
      // once inside the runner (worktree already created + added to the set).
     const abortableRunner = (_profile, _prompt, opts) =>
       new Promise((resolve) => {
         const onAbort = () => resolve({ stdout: "aborted", stderr: "", exitCode: null, signal: "SIGTERM" });
         if (opts.signal?.aborted) return onAbort();
         opts.signal?.addEventListener("abort", onAbort, { once: true });
          setImmediate(() => handlers.SIGTERM?.());
       });

     // Capture stderr writes: before the fix the handler removed the worktree but
     // left it in createdWorktrees, so the task `finally` re-ran removeWorktree on an
     // already-removed path and emitted a spurious "orphaned worktree at" warning.
     const origWrite = process.stderr.write.bind(process.stderr);
     let warnings = 0;
     process.stderr.write = (chunk, ...rest) => {
       if (typeof chunk === "string" && chunk.includes("orphaned worktree at")) warnings++;
       return origWrite(chunk, ...rest);
     };
     try {
       const result = await runDispatch(tasks, {
         cwd: repo,
         harness: "claude",
         write: true,
         maxConcurrency: 1,
         taskRunner: abortableRunner,
         resolveProfileFn: () => ({ name: "mock", baseUrl: "http://localhost", defaultModel: "mock-model", kind: "claude-gateway" }),
         skipPreflight: true,
       });

        // Both SIGINT and SIGTERM must be registered (reusing the same onSignal).
        assert.equal(registered.SIGINT, 1);
        assert.equal(registered.SIGTERM, 1, "SIGTERM handler must be registered (reuses onSignal)");
       // SIGTERM handler ran: globalAc aborted -> runner killed -> collectPatch
       // runs on the already-removed worktree -> throws -> task reported failed.
       const t1 = result.tasks.find((t) => t.id === 1);
       assert.equal(t1.status, "failed");
       // No duplicate removeWorktree warning (handler cleared the set entry).
       assert.equal(warnings, 0);
       // Listeners are removed after runDispatch completes (no leak across runs).
       assert.equal(process.listenerCount("SIGTERM"), 0);
     } finally {
        process.on = origOn;
        process.removeListener = origOff;
       process.stderr.write = origWrite;
     }
   } finally {
     rmSync(repo, { recursive: true, force: true });
   }
 });
});

// ---------------------------------------------------------------------------
// Cross-review + output rendering tests
// ---------------------------------------------------------------------------

import {
  runCrossReview,
  renderDispatchOutput,
} from "../plugins/gateway/scripts/lib/dispatch.mjs";

describe("runCrossReview", () => {
  it("writes review files to disk under outputDir/reviews when outputDir is provided", async () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-review-"));
    try {
      const results = [
        { id: 1, status: "completed", noChanges: false, prompt: "A", output: "ok", patch: "diff..." },
      ];

      const mockReview = async () => ({
        content: { findings: [{ severity: "warning", description: "x", location: "y" }], summary: "LGTM" },
        model: "mock",
        usage: null,
        parsed: true,
      });

      await runCrossReview(results, {
        reviewProfile: { name: "rev", baseUrl: "http://localhost", defaultModel: "rev-model", kind: "claude-gateway" },
        reviewModel: null,
        maxConcurrency: 1,
        reviewFn: mockReview,
        outputDir,
      });

      const reviewFile = path.join(outputDir, "reviews", "task-001-review.md");
      assert.ok(existsSync(reviewFile));
      assert.equal(results[0].review.reviewFile, reviewFile);
      const content = readFileSync(reviewFile, "utf8");
      assert.ok(content.includes("LGTM"));
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("does not write review files when outputDir is not provided", async () => {
    const results = [
      { id: 1, status: "completed", noChanges: false, prompt: "A", output: "ok", patch: "diff..." },
    ];
    const mockReview = async () => ({ content: { findings: [], summary: "ok" }, model: "m", usage: null, parsed: true });

    await runCrossReview(results, {
      reviewProfile: { name: "r", baseUrl: "http://l", defaultModel: "m", kind: "claude-gateway" },
      maxConcurrency: 1,
      reviewFn: mockReview,
    });

    assert.equal(results[0].review.reviewFile, undefined);
  });

  it("isolates a task with an unreadable patchFile: sets .review.error without crashing the batch", async () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-review-err-"));
    try {
      const results = [
        { id: 1, status: "completed", noChanges: false, prompt: "A", output: "ok", patchFile: "/nonexistent/path/does-not-exist.patch" },
        { id: 2, status: "completed", noChanges: false, prompt: "B", output: "ok", patch: "diff for task 2" },
      ];

      let reviewCalls = 0;
      const capturedPrompts = [];
      const mockReview = async (_profile, _sys, userPrompt) => {
        reviewCalls++;
        capturedPrompts.push(userPrompt);
        return { content: { findings: [], summary: "reviewed" }, model: "m", usage: null, parsed: true };
      };

      await runCrossReview(results, {
        reviewProfile: { name: "r", baseUrl: "http://l", defaultModel: "m", kind: "claude-gateway" },
        maxConcurrency: 2,
        reviewFn: mockReview,
        outputDir,
      });

      // Task 1's unreadable patchFile must not reject the whole Promise.all.
      assert.ok(results[0].review);
      assert.ok(results[0].review.error);
      assert.equal(results[0].review.findings, null);

      // Task 2 must still be reviewed normally (isolation preserved).
      assert.equal(reviewCalls, 1);
      assert.ok(results[1].review);
      assert.equal(results[1].review.error, undefined);
      assert.equal(results[1].review.summary, "reviewed");
      assert.ok(capturedPrompts[0].includes("diff for task 2"));

      // The error result is still written to disk (failures visible on disk too).
      const errorReviewFile = path.join(outputDir, "reviews", "task-001-review.md");
      assert.ok(existsSync(errorReviewFile));
      const errorContent = readFileSync(errorReviewFile, "utf8");
      assert.ok(errorContent.includes("error"));
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("isolates a review-file write failure: records reviewFileError without crashing the batch", async () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-review-writefail-"));
    try {
      // Force writeFileSync to fail for task 1 only: pre-create its target review
      // path as a *directory* so fs.writeFileSync(...) throws EISDIR. Task 2's file
      // path is untouched and writes normally. A write failure for one task's review
      // file must not reject Promise.all and abort every other task's review.
      mkdirSync(path.join(outputDir, "reviews", "task-001-review.md"), { recursive: true });

      const results = [
        { id: 1, status: "completed", noChanges: false, prompt: "A", output: "ok", patch: "diff 1" },
        { id: 2, status: "completed", noChanges: false, prompt: "B", output: "ok", patch: "diff 2" },
      ];

      const mockReview = async () => ({ content: { findings: [], summary: "LGTM" }, model: "m", usage: null, parsed: true });

      // Must not throw — before the fix, task 1's EISDIR write rejected Promise.all.
      await runCrossReview(results, {
        reviewProfile: { name: "r", baseUrl: "http://l", defaultModel: "m", kind: "claude-gateway" },
        maxConcurrency: 2,
        reviewFn: mockReview,
        outputDir,
      });

      // Task 1's write failure is recorded, not thrown; no reviewFile path was set.
      assert.ok(results[0].review);
      assert.ok(results[0].review.reviewFileError);
      assert.equal(results[0].review.reviewFile, undefined);

      // Task 2 still completed and its review landed on disk (isolation preserved).
      assert.ok(results[1].review);
      assert.equal(results[1].review.reviewFileError, undefined);
      assert.ok(existsSync(results[1].review.reviewFile));
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("skips tasks with no changes", async () => {
    const results = [
      { id: 1, status: "completed", noChanges: false, prompt: "A", output: "ok", patchFile: "/tmp/a.patch", patch: "diff..." },
      { id: 2, status: "completed_no_changes", noChanges: true, prompt: "B", output: "ok", patchFile: null },
      { id: 3, status: "failed", noChanges: false, prompt: "C", output: "", patchFile: null },
    ];

    let reviewCalls = 0;
    const mockReview = async () => {
      reviewCalls++;
      return { content: { findings: [], summary: "LGTM" }, model: "mock", usage: null, parsed: true };
    };

    await runCrossReview(results, {
      reviewProfile: { name: "rev", baseUrl: "http://localhost", defaultModel: "rev-model", kind: "claude-gateway" },
      reviewModel: null,
      timeoutMs: undefined,
      maxConcurrency: 1,
      reviewFn: mockReview,
    });

    assert.equal(reviewCalls, 1);
    assert.ok(results[0].review);
    assert.equal(results[0].review.findings.length, 0);
    assert.equal(results[1].review, undefined);
    assert.equal(results[2].review, undefined);
  });

  it("truncates patch at 20k chars for review input", async () => {
    const longPatch = "x".repeat(25_000);
    const results = [
      { id: 1, status: "completed", noChanges: false, prompt: "A", output: "ok", patch: longPatch },
    ];

    let capturedUserPrompt = "";
    const mockReview = async (_profile, _sys, userPrompt) => {
      capturedUserPrompt = userPrompt;
      return { content: { findings: [], summary: "ok" }, model: "m", usage: null, parsed: true };
    };

    await runCrossReview(results, {
      reviewProfile: { name: "r", baseUrl: "http://l", defaultModel: "m", kind: "claude-gateway" },
      maxConcurrency: 1,
      reviewFn: mockReview,
    });

    assert.ok(capturedUserPrompt.includes("[... truncated"));
    assert.ok(capturedUserPrompt.length < 25_000);
  });
});

describe("renderDispatchOutput", () => {
  it("renders summary with counts", () => {
    const result = {
      jobId: "dispatch-test123",
      baseSha: "abc123",
      outputDir: "/tmp/.gateway-dispatch/dispatch-test123",
      tasks: [
        { id: 1, status: "completed", noChanges: false, duration: 45000, profile: "minimax", model: "minimax-m3", prompt: "Add retry", patchFile: "/p/task-001.patch" },
        { id: 2, status: "failed", noChanges: false, duration: 5000, profile: "glm", model: "glm-5.2", prompt: "Fix auth", error: "timeout" },
      ],
      summary: { total: 2, completed: 1, completedNoChanges: 0, failed: 1 },
    };

    const output = renderDispatchOutput(result);
    assert.ok(output.includes("Completed: 1/2"));
    assert.ok(output.includes("Failed: 1/2"));
    assert.ok(output.includes("task-001.patch"));
    assert.ok(output.includes("FAILED"));
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("extractRepeatableFlags", () => {
  // This function lives in gateway-companion.mjs — test it via CLI integration.
  // For now, test parsing correctness via parsePlanFile / parseInlineTasks (already covered).
  // CLI-level validation is tested by running the actual binary.

  it("validates --plan and --task mutual exclusion (via CLI)", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const companion = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");

    try {
      await execFileAsync(process.execPath, [companion, "dispatch", "--plan", "file.md", "--task", "something:profile"], {
        timeout: 5000,
        env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: path.join(os.tmpdir(), "nonexistent-config") },
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.stderr.includes("mutually exclusive") || err.stderr.includes("not both"), `Expected mutual exclusion error, got: ${err.stderr}`);
      // Regression guard for main()'s catch handler: `process.exitCode = process.exitCode || 1`
      // must preserve the validationError()-set exit code 2, not clobber it back to 1.
      assert.equal(err.code, 2, `Expected exit code 2 for a validation error, got ${err.code}`);
    }
  });

  it("validates --assign requires --plan", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const companion = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");

    try {
      await execFileAsync(process.execPath, [companion, "dispatch", "--task", "something:p", "--assign", "1:a"], {
        timeout: 5000,
        env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: path.join(os.tmpdir(), "nonexistent-config") },
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.stderr.includes("--assign") && err.stderr.includes("--plan"), `Expected --assign/--plan error, got: ${err.stderr}`);
    }
  });
});

describe("handleDispatch profile-kind preflight validation (via CLI)", () => {
  function writeConfig(tmpDir, config) {
    writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config, null, 2));
  }

  function makeTmpConfigDir() {
    return mkdtempSync(path.join(os.tmpdir(), "gw-dispatch-kind-test-"));
  }

  it("exits 2 when a --task profile has kind !== claude-gateway", async () => {
    const tmpDir = makeTmpConfigDir();
    writeConfig(tmpDir, {
      profiles: {
        good: { kind: "claude-gateway", baseUrl: "http://localhost:1", defaultModel: "m" },
        badkind: { kind: "openai", baseUrl: "http://localhost:2", defaultModel: "m" },
      },
      defaultProfile: "good",
      reviewProfile: null,
      taskProfile: "good",
    });

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const companion = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");

    try {
      await execFileAsync(process.execPath, [companion, "dispatch", "--task", "do something:badkind"], {
        timeout: 5000,
        env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: tmpDir },
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `Expected exit code 2, got ${err.code}. stderr: ${err.stderr}`);
      assert.ok(err.stderr.includes("badkind"), `Expected error to name the offending profile, got: ${err.stderr}`);
      assert.ok(err.stderr.includes("claude-gateway"), `Expected error to mention the required kind, got: ${err.stderr}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits 2 (not 1) when a referenced profile does not exist in config", async () => {
    const tmpDir = makeTmpConfigDir();
    writeConfig(tmpDir, {
      profiles: {
        good: { kind: "claude-gateway", baseUrl: "http://localhost:1", defaultModel: "m" },
      },
      defaultProfile: "good",
      reviewProfile: null,
      taskProfile: "good",
    });

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const companion = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");

    try {
      await execFileAsync(process.execPath, [companion, "dispatch", "--task", "do something:missingprofile"], {
        timeout: 5000,
        env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: tmpDir },
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `Expected exit code 2 (not 1) for profile-not-found, got ${err.code}. stderr: ${err.stderr}`);
      assert.ok(err.stderr.includes("missingprofile") || err.stderr.toLowerCase().includes("not found"), `Expected not-found error, got: ${err.stderr}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("cleanOrphanedWorktrees (regression)", () => {
  function makeJobDir(repo, jobId) {
    const jobDir = path.join(repo, ".gateway-dispatch", jobId);
    mkdirSync(path.join(jobDir, "patches"), { recursive: true });
    writeFileSync(path.join(jobDir, "patches", "task-001.patch"), "diff --git a/f b/f\n+content\n");
    mkdirSync(path.join(jobDir, "logs"), { recursive: true });
    writeFileSync(path.join(jobDir, "logs", "task-001.log"), "log\n");
    writeFileSync(path.join(jobDir, "manifest.json"), JSON.stringify({ jobId, tasks: [], summary: {} }, null, 2) + "\n");
    return jobDir;
  }

  it("preserves patches/, logs/ and manifest.json of completed jobs", () => {
    const repo = createTempGitRepo();
    try {
      const jobDir = makeJobDir(repo, "dispatch-oldjob");
      cleanOrphanedWorktrees(repo);
      assert.ok(existsSync(path.join(jobDir, "manifest.json")), "manifest.json must survive cleanup");
      assert.ok(existsSync(path.join(jobDir, "patches", "task-001.patch")), "patches/ must survive cleanup");
      assert.ok(existsSync(path.join(jobDir, "logs", "task-001.log")), "logs/ must survive cleanup");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("removes orphaned worktrees but leaves job results intact", () => {
    const repo = createTempGitRepo();
    try {
      const jobDir = makeJobDir(repo, "dispatch-orphan");
      const baseSha = headSha(repo);
      const wtPath = path.join(jobDir, "worktrees", "task-1");
      createWorktree(repo, wtPath, baseSha);
      assert.ok(existsSync(path.join(wtPath, "file.txt")));

      cleanOrphanedWorktrees(repo);

      assert.ok(!existsSync(wtPath), "orphaned worktree must be removed");
      assert.ok(existsSync(path.join(jobDir, "manifest.json")), "manifest.json must survive cleanup");
      assert.ok(existsSync(path.join(jobDir, "patches", "task-001.patch")), "patches/ must survive cleanup");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips a job marked active by a live PID (lock file)", () => {
    const repo = createTempGitRepo();
    try {
      const jobDir = makeJobDir(repo, "dispatch-active");
      const baseSha = headSha(repo);
      const wtPath = path.join(jobDir, "worktrees", "task-1");
      createWorktree(repo, wtPath, baseSha);
      writeFileSync(path.join(jobDir, "active.lock"), String(process.pid), "utf8");

      cleanOrphanedWorktrees(repo);

      assert.ok(existsSync(wtPath), "worktree of an active job must not be touched");
      assert.ok(existsSync(path.join(jobDir, "manifest.json")), "manifest.json must survive cleanup");
      removeWorktree(repo, wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("treats a stale lock (dead PID) as inactive and still cleans worktrees", () => {
    const repo = createTempGitRepo();
    try {
      const jobDir = makeJobDir(repo, "dispatch-stale");
      const baseSha = headSha(repo);
      const wtPath = path.join(jobDir, "worktrees", "task-1");
      createWorktree(repo, wtPath, baseSha);
      writeFileSync(path.join(jobDir, "active.lock"), "999999", "utf8");

      cleanOrphanedWorktrees(repo);

      assert.ok(!existsSync(wtPath), "stale-lock worktree must be removed");
      assert.ok(existsSync(path.join(jobDir, "patches", "task-001.patch")), "patches/ must survive cleanup");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not abort when .gateway-dispatch is unreadable", () => {
    const repo = createTempGitRepo();
    try {
      const dispatchDir = path.join(repo, ".gateway-dispatch");
      mkdirSync(dispatchDir, { recursive: true });
      fsChmodSync(dispatchDir, 0o000);
      cleanOrphanedWorktrees(repo);
      fsChmodSync(dispatchDir, 0o755);
      assert.ok(true, "cleanOrphanedWorktrees tolerated an unreadable dispatch dir");
    } finally {
      try { fsChmodSync(path.join(repo, ".gateway-dispatch"), 0o755); } catch {}
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("handleDispatch hardening (via CLI)", () => {
  function writeConfig(tmpDir, config) {
    writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config, null, 2));
  }

  function makeTmpConfigDir() {
    return mkdtempSync(path.join(os.tmpdir(), "gw-dispatch-hardening-"));
  }

  function goodConfig(tmpDir) {
    writeConfig(tmpDir, {
      profiles: {
        good: { kind: "claude-gateway", baseUrl: "http://localhost:1", defaultModel: "m" },
        rev: { kind: "claude-gateway", baseUrl: "http://localhost:2", defaultModel: "m" },
      },
      defaultProfile: "good",
      reviewProfile: "rev",
      taskProfile: "good",
    });
  }

  const companion = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");

  async function runDispatchCli(tmpDir, args) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    return execFileAsync(process.execPath, [companion, "dispatch", ...args], {
      timeout: 10000,
      env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: tmpDir },
    });
  }

  // Fix 1: --plan pointing at an unreadable/missing file must exit 2 (validation
  // contract), not 1 (uncaught exception bubbling to main()).
  it("exits 2 with a clear message when --plan file cannot be read", async () => {
    const tmpDir = makeTmpConfigDir();
    goodConfig(tmpDir);
    try {
      await runDispatchCli(tmpDir, ["--plan", path.join(tmpDir, "does-not-exist.md")]);
      assert.fail("Should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `Expected exit code 2 for unreadable plan file, got ${err.code}. stderr: ${err.stderr}`);
      assert.ok(
        err.stderr.includes("No se pudo leer el plan file") && err.stderr.includes("does-not-exist.md"),
        `Expected a clear unreadable-plan message naming the path, got: ${err.stderr}`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Fix 2: --write and --no-write are mutually exclusive.
  it("exits 2 when both --write and --no-write are passed", async () => {
    const tmpDir = makeTmpConfigDir();
    goodConfig(tmpDir);
    try {
      await runDispatchCli(tmpDir, ["--task", "do something:good", "--write", "--no-write", "--dry-run"]);
      assert.fail("Should have thrown");
    } catch (err) {
      assert.equal(err.code, 2, `Expected exit code 2 for --write/--no-write conflict, got ${err.code}. stderr: ${err.stderr}`);
      assert.ok(
        err.stderr.includes("--write") && err.stderr.includes("--no-write") && err.stderr.includes("mutuamente excluyentes"),
        `Expected mutual-exclusion error, got: ${err.stderr}`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Fix 3: --model-override referencing a profile not used by any task emits a
  // warning to stderr (the task still runs; here we use --dry-run to avoid network).
  it("warns on stderr when --model-override targets an unused profile (--dry-run)", async () => {
    const tmpDir = makeTmpConfigDir();
    goodConfig(tmpDir);
    try {
      const { stdout, stderr } = await runDispatchCli(tmpDir, [
        "--task", "do something:good", "--model-override", "minimx:m3", "--dry-run",
      ]);
      assert.ok(
        stderr.includes("--model-override references profile \"minimx\"") && stderr.includes("not used by any task"),
        `Expected a warning about the unused override profile "minimx", got stderr: ${stderr}`,
      );
      // dry-run still succeeds (exit 0) and prints its matrix.
      assert.ok(stdout.includes("Dispatch dry-run"), `Expected dry-run output, got: ${stdout}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not warn when --model-override matches a used profile (--dry-run)", async () => {
    const tmpDir = makeTmpConfigDir();
    goodConfig(tmpDir);
    try {
      const { stderr } = await runDispatchCli(tmpDir, [
        "--task", "do something:good", "--model-override", "good:m", "--dry-run",
      ]);
      assert.ok(
        !stderr.includes("not used by any task"),
        `Expected no unused-profile warning for a matching override, got stderr: ${stderr}`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Fix 4: the redundant pre-read loop was removed; runCrossReview reads patchFile
  // internally and isolates read failures. That isolation is already covered by the
  // "isolates a task with an unreadable patchFile" runCrossReview test above. Here
  // we add a focused library-level check that a task with only patchFile (no pre-set
  // .patch) is still reviewed via the internal read path.
  it("runCrossReview reads task.patchFile internally when task.patch is absent (Fix 4 regression guard)", async () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-fix4-"));
    try {
      const patchFile = path.join(outputDir, "task-001.patch");
      writeFileSync(patchFile, "diff --git a/x b/x\n+hello\n");
      const results = [
        { id: 1, status: "completed", noChanges: false, prompt: "A", output: "ok", patchFile },
      ];
      let captured = "";
      const mockReview = async (_p, _s, userPrompt) => {
        captured = userPrompt;
        return { content: { findings: [], summary: "ok" }, model: "m", usage: null, parsed: true };
      };
      await runCrossReview(results, {
        reviewProfile: { name: "r", baseUrl: "http://l", defaultModel: "m", kind: "claude-gateway" },
        maxConcurrency: 1,
        reviewFn: mockReview,
        outputDir,
      });
      // The review prompt must contain the patch contents read from patchFile.
      assert.ok(captured.includes("+hello"), `Expected review input to include the patch read from patchFile, got: ${captured}`);
      assert.equal(results[0].review.error, undefined);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  // Fix 5 & Fix 6 guard code paths that only run during a real dispatch execution
  // (after network preflight / inside the task-runner wiring), which the CLI test
  // harness cannot reach without a live gateway. Their failure-isolation behavior
  // for cross-review writes is covered by the runCrossReview library tests above;
  // the manifest-rewrite try/catch and the taskRunner/resolveProfileFn typeof guards
  // are defensive against future refactors and are exercised by the happy-path
  // dispatch tests (runDispatch) rather than by CLI integration here.
});
