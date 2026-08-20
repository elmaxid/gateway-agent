/**
 * Proves executeReviewRun()'s agentic path fails loud (exitStatus: 1, explicit
 * "FAILED" render) instead of silently rendering malformed model output as if
 * it were a valid review (the pre-v0.3.5 behavior: exitStatus: 0 always, with
 * only a console.warn that's easy to miss in scripted/CI usage).
 *
 * Companion to tests/agentic-review.test.mjs (which proves runToolLoop/
 * forceFinish's own retry-and-ok behavior, including the review-shape
 * validation, in isolation) — this file proves the outer executeReviewRun
 * wiring actually surfaces ok:false as a failed run, and that a mid-run
 * recovery still produces a normal successful review.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { executeReviewRun } from "../plugins/gateway/scripts/gateway-companion.mjs";
import { createTempRepo, runGit } from "./helpers/git-fixture.mjs";

function makeFixtureRepo() {
  const repo = createTempRepo("gw-malformed-repo-");
  writeFileSync(path.join(repo.dir, "change.txt"), "malformed fixture change\n");
  runGit(repo.dir, ["add", "change.txt"]);
  return repo;
}

function malformedCompletion() {
  return JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "]<]minimax[>[<tool_call><invoke name=\"read_file\"></invoke></tool_call>" },
    }],
  });
}

function validCompletion() {
  return JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify({ verdict: "approve", summary: "looks fine", findings: [], next_steps: [] }) },
    }],
  });
}

describe("executeReviewRun agentic path — malformed output handling", () => {
  it("returns exitStatus 1 and a FAILED render when the model returns malformed output twice in a row", async () => {
    const repo = makeFixtureRepo();
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(malformedCompletion());
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const result = await executeReviewRun({
        cwd: repo.dir,
        profile: { name: "malformed-test", kind: "claude-gateway", baseUrl: `http://127.0.0.1:${port}`, defaultModel: "test-model" },
        scope: "working-tree",
      });

      assert.strictEqual(result.exitStatus, 1, "expected exitStatus 1 when the model never recovers a valid response");
      assert.match(result.rendered, /FAILED/, "expected the rendered output to explicitly say the review failed, not present garbage as a review");
      assert.strictEqual(result.payload.error, "malformed_model_output");
    } finally {
      await new Promise((resolve) => server.close(resolve));
      repo.cleanup();
    }
  });

  it("returns exitStatus 0 and a normal review render when the model recovers on retry", async () => {
    const repo = makeFixtureRepo();
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(requestCount === 1 ? malformedCompletion() : validCompletion());
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const result = await executeReviewRun({
        cwd: repo.dir,
        profile: { name: "recovers-test", kind: "claude-gateway", baseUrl: `http://127.0.0.1:${port}`, defaultModel: "test-model" },
        scope: "working-tree",
      });

      assert.strictEqual(result.exitStatus, 0, "expected exitStatus 0 once the retry recovers a valid review");
      assert.doesNotMatch(result.rendered, /FAILED/, "expected a normal review render, not a failure render");
      assert.strictEqual(result.payload.result.verdict, "approve");
    } finally {
      await new Promise((resolve) => server.close(resolve));
      repo.cleanup();
    }
  });
});
