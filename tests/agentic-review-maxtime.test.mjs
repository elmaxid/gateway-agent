/**
 * Proves executeReviewRun()'s agentic-path maxTime scaling formula --
 * `timeoutMs ? Math.max(120_000, timeoutMs * 2) : 120_000` -- actually reaches
 * the tool loop's deadline check, instead of the old hardcoded `120_000`.
 *
 * This is the original motivating fix of the v0.3.4 release (a slow model's
 * agentic review could get silently truncated even after --timeout was
 * threaded through, because the loop's own deadline never scaled with it).
 * tests/agentic-review.test.mjs exercises runToolLoop's timeoutMs threading
 * directly, but always passes its own explicit maxTime -- it never goes
 * through executeReviewRun's scaling logic. tests/cli-timeout.test.mjs's
 * review case uses --no-tools, which bypasses the agentic path (and this
 * formula) entirely. This file closes that gap.
 *
 * The scaled maxTime floors at 120_000ms (2 minutes), so no value of
 * --timeout can make the real deadline short enough to cross in a fast test
 * -- waiting it out for real is not viable. Instead, Date.now is
 * monkeypatched: the loop's very first deadline check happens under the
 * real (unmodified) clock, so the first tool-capable request reaches the
 * mock server unmodified. From inside the mock server's handler for THAT
 * request, the mocked clock is jumped forward past the OLD hardcoded
 * 120_000 deadline but still under the NEW scaled deadline (200_000, for
 * timeoutMs=100_000 used here). The loop's next deadline check -- which
 * runs after the jump -- then diverges depending on which maxTime was
 * actually used:
 *   - old hardcoded 120_000: exceeded -> loop force-finishes early. That
 *     request has no "tools" key (forceFinish's chatCompletion call omits
 *     tools) and appends a "produce final JSON now" user message.
 *   - correctly scaled 200_000: not yet exceeded -> loop continues
 *     normally. That request still carries the "tools" key.
 * So asserting the shape of the second HTTP request proves which maxTime
 * value was actually in effect, deterministically and without waiting out
 * any real deadline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { executeReviewRun } from "../plugins/gateway/scripts/gateway-companion.mjs";
import { createTempRepo, runGit } from "./helpers/git-fixture.mjs";

// timeoutMs * 2 = 200_000, which is > the old hardcoded 120_000 -- the two
// are only distinguishable when timeoutMs > 60_000 (otherwise Math.max
// picks the same 120_000 floor either way).
const TIMEOUT_MS = 100_000;
// Past the old hardcoded deadline (120_000) but short of the scaled one
// (200_000) -- the exact value that tells the two formulas apart.
const CLOCK_JUMP_MS = 150_000;

function toolCallCompletion() {
  return JSON.stringify({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "list_changed_files", arguments: "{}" },
            },
          ],
        },
      },
    ],
  });
}

function finalCompletion() {
  return JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify({ verdict: "approve", summary: "ok", findings: [] }) },
    }],
  });
}

describe("executeReviewRun agentic maxTime scaling", () => {
  it("uses Math.max(120_000, timeoutMs * 2) as the tool loop deadline, not the old hardcoded 120_000", async () => {
    const repo = createTempRepo("gw-maxtime-repo-");
    writeFileSync(path.join(repo.dir, "change.txt"), "maxtime fixture change\n");
    runGit(repo.dir, ["add", "change.txt"]);

    const realDateNow = Date.now;
    const t0 = realDateNow();
    let clockJumped = false;
    const requests = [];

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        if (requests.length === 1) {
          // First request landed under the real, unmodified clock -- proof
          // the loop hadn't already force-finished before even trying.
          // Now jump the clock forward past the old hardcoded deadline
          // (120_000) but under the new scaled one (200_000), before the
          // loop's next deadline check runs.
          Date.now = () => t0 + CLOCK_JUMP_MS;
          clockJumped = true;
          res.end(toolCallCompletion());
        } else {
          res.end(finalCompletion());
        }
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      await executeReviewRun({
        cwd: repo.dir,
        profile: {
          name: "maxtime-test",
          kind: "claude-gateway",
          baseUrl: `http://127.0.0.1:${port}`,
          defaultModel: "test-model",
        },
        scope: "working-tree",
        timeoutMs: TIMEOUT_MS,
      });
    } finally {
      Date.now = realDateNow;
      await new Promise((resolve) => server.close(resolve));
      repo.cleanup();
    }

    assert.ok(clockJumped, "expected the mock server to have jumped the clock after the first request");
    assert.strictEqual(
      requests.length,
      2,
      `expected exactly 2 HTTP requests (1 tool-capable call, then 1 more once the jumped clock is observed), got ${requests.length}`
    );

    const secondRequest = requests[1];
    assert.ok(
      "tools" in secondRequest,
      "expected the second request to still be a normal tool-capable loop iteration (with a \"tools\" key), " +
        "proving the deadline reflected the scaled maxTime (200_000 for timeoutMs=100_000) rather than the " +
        "old hardcoded 120_000 (which would have forced an early forceFinish() call with no \"tools\" key)"
    );

    const lastMessage = secondRequest.messages.at(-1);
    assert.notStrictEqual(
      lastMessage?.content,
      "You must now produce your final review as valid JSON only. No tool calls.",
      "expected no forceFinish() forced-completion message -- its presence would mean the deadline fired early"
    );
  });
});
