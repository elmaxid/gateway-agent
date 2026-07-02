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

describe("runToolLoop malformed output handling", () => {
  it("retries once when the terminal turn is malformed, and returns ok:false if the retry is also malformed", async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "]<]minimax[>[<tool_call><invoke name=\"read_file\"></invoke></tool_call>" },
        }],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = { baseUrl: `http://127.0.0.1:${port}`, defaultModel: "test-model" };

    try {
      const result = await runToolLoop(profile, messages, tools, { maxIterations: 1, maxTime: 5000 });
      assert.strictEqual(result.ok, false, "expected ok:false after both the original attempt and the retry return malformed content");
      assert.strictEqual(requestCount, 2, "expected exactly 2 requests: the original attempt plus one retry");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects a JSON-parseable fragment that isn't shaped like a review, even though a bare JSON.parse would accept it", async () => {
    // Regression test for a blocker raised in pre-implementation multi-model
    // review (Codex): a malformed tool-call template can still contain a
    // stray {...} substring (e.g. leftover tool-call arguments) that
    // extractJson's permissive brace-slicing would parse successfully, even
    // though it's not a real review. isValidReviewPayload must reject it
    // because it lacks verdict/summary/findings, not just check parseability.
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: 'garbage before <invoke>{"path":"README.md"} garbage after' },
        }],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = { baseUrl: `http://127.0.0.1:${port}`, defaultModel: "test-model" };

    try {
      const result = await runToolLoop(profile, messages, tools, { maxIterations: 1, maxTime: 5000 });
      assert.strictEqual(result.ok, false, "expected ok:false — the embedded {\"path\":\"README.md\"} fragment is parseable JSON but has no verdict/summary/findings, so it is not a valid review");
      assert.strictEqual(requestCount, 2, "expected exactly 2 requests: the original attempt plus one retry, both returning the same non-review fragment");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("retries once when the terminal turn is malformed, and returns ok:true if the retry succeeds", async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (requestCount === 1) {
        res.end(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "]<]minimax[>[<tool_call></tool_call>" } }],
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ verdict: "approve", summary: "ok", findings: [] }) } }],
        }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = { baseUrl: `http://127.0.0.1:${port}`, defaultModel: "test-model" };

    try {
      const result = await runToolLoop(profile, messages, tools, { maxIterations: 1, maxTime: 5000 });
      assert.strictEqual(result.ok, true, "expected ok:true once the retry returns a valid review payload");
      assert.deepStrictEqual(JSON.parse(result.content), { verdict: "approve", summary: "ok", findings: [] });
      assert.strictEqual(requestCount, 2, "expected exactly 2 requests: the malformed original attempt plus the successful retry");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("recovers via a proper tool_calls response on retry, and continues the loop normally instead of terminating", async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (requestCount === 1) {
        res.end(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "]<]minimax[>[<tool_call></tool_call>" } }],
        }));
      } else if (requestCount === 2) {
        res.end(JSON.stringify({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "noop", arguments: "{}" } }],
            },
          }],
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ verdict: "approve", summary: "ok", findings: [] }) } }],
        }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = { baseUrl: `http://127.0.0.1:${port}`, defaultModel: "test-model" };

    try {
      const result = await runToolLoop(profile, messages, tools, { maxIterations: 3, maxTime: 5000 });
      assert.strictEqual(result.ok, true, "expected ok:true after the loop continues past the recovered tool_calls turn");
      assert.strictEqual(requestCount, 3, "expected 3 requests: malformed, recovered tool_calls, final valid review");
      const toolMsg = result.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg, "expected the loop to have actually dispatched the tool call recovered on retry");
      assert.match(toolMsg.content, /unknown tool/, "the 'noop' tool isn't in dispatchTool's switch, so it should surface as an unknown-tool error, proving dispatch really ran");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("forceFinish retries once when its response is malformed, and returns ok:true if the retry succeeds", async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (requestCount === 1) {
        res.end(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "]<]minimax[>[<tool_call></tool_call>" } }],
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ verdict: "approve", summary: "ok", findings: [] }) } }],
        }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = { baseUrl: `http://127.0.0.1:${port}`, defaultModel: "test-model" };

    try {
      // maxTime: -1 forces the deadline-already-passed branch, which calls
      // forceFinish() on the very first iteration (same pattern as the
      // existing "threads timeoutMs to chatCompletion in forceFinish" test).
      const result = await runToolLoop(profile, messages, tools, { maxTime: -1 });
      assert.strictEqual(result.ok, true, "expected ok:true once forceFinish's retry returns a valid review payload");
      assert.strictEqual(requestCount, 2, "expected exactly 2 requests: forceFinish's original attempt plus its retry");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("forceFinish returns ok:false if its response is malformed twice in a row", async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "]<]minimax[>[<tool_call></tool_call>" } }],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = { baseUrl: `http://127.0.0.1:${port}`, defaultModel: "test-model" };

    try {
      const result = await runToolLoop(profile, messages, tools, { maxTime: -1 });
      assert.strictEqual(result.ok, false, "expected ok:false after forceFinish's original attempt and its retry both return malformed content");
      assert.strictEqual(requestCount, 2, "expected exactly 2 requests: forceFinish's original attempt plus its retry");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
