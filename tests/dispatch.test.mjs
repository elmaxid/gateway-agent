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
