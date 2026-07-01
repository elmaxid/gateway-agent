import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point config at a temp directory so these tests don't depend on the
// operator's real ~/.gateway-plugin/config.json (see tests/config.test.mjs
// for the same pattern). Must happen before config.mjs/debate.mjs are
// imported, since CONFIG_PATH is computed at module-load time.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-debate-test-"));
process.env.GATEWAY_PLUGIN_CONFIG_DIR = tmpDir;

const { saveConfig } = await import("../plugins/gateway/scripts/lib/config.mjs");
const debateModule = await import("../plugins/gateway/scripts/lib/debate.mjs");

// glm and minimax share the same scheme://host but differ in path, so they
// exercise normalizeBaseUrl() (semaphore key = scheme://host, not raw string).
saveConfig({
  profiles: {
    glm: { kind: "claude-gateway", baseUrl: "http://backend-a.test:9999", defaultModel: "test-model-glm" },
    minimax: { kind: "claude-gateway", baseUrl: "http://backend-a.test:9999/some/prefix", defaultModel: "test-model-minimax" },
  },
  defaultProfile: "glm",
  reviewProfile: null,
  taskProfile: null,
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

describe("runDebate per-backend semaphore + timeoutMs", () => {
  it("serializes requests to the same backend by default, normalizing baseUrl by scheme://host", async () => {
    // glm and minimax point at the same scheme://host (different path).
    // Track how many fetch calls are simultaneously in flight: without
    // per-backend serialization, Promise.all fires both positions'
    // requests in the same tick (2 concurrent). With the default
    // maxConcurrency=1 semaphore, the second must wait for the first to release.
    const origFetch = globalThis.fetch;
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = (url, opts) => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        setTimeout(() => {
          active--;
          resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) });
        }, 30);
      });
    };

    try {
      await debateModule.runDebate({
        question: "test question",
        profileNames: ["glm", "minimax"], // same host, different path
        rounds: 1,
        json: true,
      });
      assert.strictEqual(
        maxActive,
        1,
        `expected requests to the shared backend to be serialized by default (max 1 concurrent in flight), got ${maxActive}`
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("threads timeoutMs through to chatCompletion, aborting slow calls instead of waiting for the default 60s timeout", async () => {
    const origFetch = globalThis.fetch;
    let sawAbort = false;
    globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) });
      }, 500);
      opts?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        sawAbort = true;
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });

    try {
      await assert.rejects(
        () => debateModule.runDebate({
          question: "test question",
          profileNames: ["glm"],
          rounds: 1,
          json: true,
          timeoutMs: 20,
        }),
        (err) => err.message.includes("All debate participants failed")
      );
      assert.strictEqual(sawAbort, true, "expected the short timeoutMs to abort the slow mock request");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
