import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as debateModule from "../plugins/gateway/scripts/lib/debate.mjs";

describe("debate exports", () => {
  it("exports runDebate function", () => {
    assert.strictEqual(typeof debateModule.runDebate, "function");
  });

  it("exports renderDebateOutput function", () => {
    assert.strictEqual(typeof debateModule.renderDebateOutput, "function");
  });

  it("exports preflightProfiles function", () => {
    assert.strictEqual(typeof debateModule.preflightProfiles, "function");
  });
});

describe("runDebate quorum enforcement", () => {
  it("returns quorum_failed when only 1 of 2 profiles responds (mode=standard)", async () => {
    let callCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      callCount++;
      const body = JSON.parse(opts?.body ?? "{}");
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "Position from model 1" } }],
            model: body.model,
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        };
      }
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };

    try {
      const result = await debateModule.runDebate({
        question: "test question",
        profileNames: ["glm", "minimax"],
        mode: "standard",
        json: true,
      });
      assert.strictEqual(result.quorum_failed, true);
      assert.strictEqual(result.quorum.need, 2);
      assert.strictEqual(result.quorum.got, 1);
      assert.strictEqual(result.quorum.mode, "standard");
      assert.strictEqual(result.synthesis, null);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("continues when quorum met in relaxed mode (1 of 2 responds)", async () => {
    let callCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      callCount++;
      const body = JSON.parse(opts?.body ?? "{}");
      if (callCount <= 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: `Response ${callCount}` } }],
            model: body.model,
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        };
      }
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };

    try {
      const result = await debateModule.runDebate({
        question: "test question",
        profileNames: ["glm", "minimax"],
        mode: "relaxed",
        rounds: 1,
        json: true,
      });
      assert.strictEqual(result.quorum_failed, undefined);
      assert.ok(result.positions.length >= 1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("still throws when ALL models fail regardless of mode", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };

    try {
      await assert.rejects(
        () => debateModule.runDebate({
          question: "test",
          profileNames: ["glm", "minimax"],
          mode: "relaxed",
          json: true,
        }),
        (err) => err.message.includes("All debate participants failed")
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
