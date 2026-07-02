import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { runToolLoop } from "../plugins/gateway/scripts/lib/agentic-review.mjs";

// Minimal fixtures — just enough to satisfy runToolLoop's signature.
// The mock server never responds, so no tool call is ever dispatched;
// the shape of `tools` doesn't matter beyond being an array.
const messages = [{ role: "user", content: "test" }];
const tools = [];

describe("runToolLoop timeoutMs threading", () => {
  it("threads timeoutMs to chatCompletion in the main loop, aborting a hanging endpoint instead of waiting for the default 60s timeout", async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      // Deliberately never respond — the client must abort via timeoutMs.
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = {
      baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: "test-model",
    };

    try {
      const start = Date.now();
      await assert.rejects(
        () => runToolLoop(profile, messages, tools, {
          timeoutMs: 200,
          maxIterations: 1,
          maxTime: 5000, // deadline far in the future — reaches chatCompletion, not forceFinish
        }),
        (err) => err.name === "AbortError" || err.message.includes("aborted")
      );
      const duration = Date.now() - start;

      assert.ok(duration < 200 + 3000,
        `expected runToolLoop to abort near timeoutMs=200, took ${duration}ms`);
      assert.ok(requestCount >= 1, "expected the server to have received the request");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("threads timeoutMs to chatCompletion in forceFinish, aborting a hanging endpoint instead of waiting for the default 60s timeout", async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      // Deliberately never respond — the client must abort via timeoutMs.
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = {
      baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: "test-model",
    };

    try {
      const start = Date.now();
      await assert.rejects(
        () => runToolLoop(profile, messages, tools, {
          timeoutMs: 200,
          maxTime: -1, // deadline already passed — forces the forceFinish() branch immediately
        }),
        (err) => err.name === "AbortError" || err.message.includes("aborted")
      );
      const duration = Date.now() - start;

      assert.ok(duration < 200 + 3000,
        `expected forceFinish to abort near timeoutMs=200, took ${duration}ms`);
      assert.ok(requestCount >= 1, "expected the server to have received the request");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
