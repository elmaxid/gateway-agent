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
  it("parses inclusive ranges", () => {
    const map = parseAssignment("1-3:minimax,4-6:glm", 6);
    assert.equal(map.get(1), "minimax");
    assert.equal(map.get(3), "minimax");
    assert.equal(map.get(4), "glm");
    assert.equal(map.get(6), "glm");
  });

  it("parses single-ID assignment", () => {
    const map = parseAssignment("4:glm", 6);
    assert.equal(map.get(4), "glm");
    assert.equal(map.has(1), false);
  });

  it("throws on overlapping ranges", () => {
    assert.throws(() => parseAssignment("1-3:a,2-4:b", 6), /overlap/i);
  });

  it("throws on out-of-bounds range", () => {
    assert.throws(() => parseAssignment("1-10:a", 6), /exceeds task count/i);
  });

  it("throws on invalid range (start > end)", () => {
    assert.throws(() => parseAssignment("5-3:a", 6), /Invalid range/i);
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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
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
      assert.ok(patch.includes("modified"));
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
  it("appends .gateway-dispatch/ to .gitignore if missing", () => {
    const repo = createTempGitRepo();
    try {
      ensureDispatchGitignore(repo);
      const content = readFileSync(path.join(repo, ".gitignore"), "utf8");
      assert.ok(content.includes(".gateway-dispatch/"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not duplicate if already present", () => {
    const repo = createTempGitRepo();
    try {
      writeFileSync(path.join(repo, ".gitignore"), ".gateway-dispatch/\n");
      ensureDispatchGitignore(repo);
      const content = readFileSync(path.join(repo, ".gitignore"), "utf8");
      const count = content.split(".gateway-dispatch/").length - 1;
      assert.equal(count, 1);
    } finally {
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
