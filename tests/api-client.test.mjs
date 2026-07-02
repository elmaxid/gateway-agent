import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";

import * as apiClient from "../plugins/gateway/scripts/lib/api-client.mjs";

// ---------------------------------------------------------------------------
// Verify module exports
// ---------------------------------------------------------------------------

describe("api-client exports", () => {
  it("exports chatCompletion function", () => {
    assert.strictEqual(typeof apiClient.chatCompletion, "function");
  });

  it("exports chatCompletionStream generator", () => {
    assert.strictEqual(typeof apiClient.chatCompletionStream, "function");
  });

  it("exports runDirectReview function", () => {
    assert.strictEqual(typeof apiClient.runDirectReview, "function");
  });

  it("exports testConnectivity function", () => {
    assert.strictEqual(typeof apiClient.testConnectivity, "function");
  });

  it("exports listModels function", () => {
    assert.strictEqual(typeof apiClient.listModels, "function");
  });
});

// ---------------------------------------------------------------------------
// chatCompletion - error cases (no network needed)
// ---------------------------------------------------------------------------

describe("chatCompletion error handling", () => {
  it("throws when profile has no baseUrl", async () => {
    const badProfile = { defaultModel: "m" };
    await assert.rejects(
      () => apiClient.chatCompletion(badProfile, [{ role: "user", content: "hi" }]),
      // fetch will fail on an invalid URL
      (err) => err instanceof Error
    );
  });

  it("throws when baseUrl is unreachable", async () => {
    const profile = {
      baseUrl: "http://127.0.0.1:1",
      defaultModel: "test-model",
    };
    await assert.rejects(
      () => apiClient.chatCompletion(profile, [{ role: "user", content: "test" }]),
      (err) => err instanceof Error
    );
  });
});

// ---------------------------------------------------------------------------
// testConnectivity - returns error object instead of throwing
// ---------------------------------------------------------------------------

describe("testConnectivity error wrapping", () => {
  it("returns ok:false with sanitized error for unreachable host", async () => {
    const profile = {
      baseUrl: "http://127.0.0.1:1",
      defaultModel: "test-model",
      authToken: "sk-secret-token-12345",
    };
    const result = await apiClient.testConnectivity(profile);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.model, null);
    assert.strictEqual(typeof result.error, "string");
    assert.strictEqual(typeof result.latencyMs, "number");
    // Auth token must not appear in error output
    assert.ok(!result.error.includes("sk-secret-token-12345"),
      "Error message must not leak auth tokens");
  });
});

// ---------------------------------------------------------------------------
// runDirectReview - validates message structure (fails on network, not shape)
// ---------------------------------------------------------------------------

describe("runDirectReview", () => {
  it("propagates fetch errors without leaking auth", async () => {
    const profile = {
      baseUrl: "http://127.0.0.1:1",
      defaultModel: "test-model",
      authToken: "Bearer super-secret",
    };
    try {
      await apiClient.runDirectReview(profile, "system prompt", "user prompt");
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(!err.message.includes("super-secret"),
        "Error should not contain auth token");
    }
  });
});

// ---------------------------------------------------------------------------
// chatCompletion per-attempt timeout
// ---------------------------------------------------------------------------

describe("chatCompletion per-attempt timeout", () => {
  it("throws AbortError when endpoint hangs beyond timeout", async () => {
    const server = net.createServer((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = {
      baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: "test-model",
    };
    try {
      await assert.rejects(
        () => apiClient.chatCompletion(profile, [{ role: "user", content: "test" }], {
          timeoutMs: 200,
        }),
        (err) => {
          return err.name === "AbortError" || err.message.includes("aborted");
        }
      );
    } finally {
      server.close();
    }
  });

  it("does not retry AbortError (timeout is non-retriable, single attempt)", async () => {
    let attemptCount = 0;
    const server = net.createServer((socket) => {
      attemptCount++;
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const profile = {
      baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: "test-model",
    };
    try {
      await assert.rejects(
        () => apiClient.chatCompletion(profile, [{ role: "user", content: "test" }], {
          timeoutMs: 200,
        }),
        (err) => err.name === "AbortError" || err.message.includes("aborted")
      );
      assert.strictEqual(attemptCount, 1, "AbortError should not trigger retry");
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// testConnectivity timeoutMs
// ---------------------------------------------------------------------------

describe("testConnectivity timeoutMs", () => {
  it("aborts a hanging endpoint using opts.timeoutMs instead of waiting for the default 60s timeout", async () => {
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
      const result = await apiClient.testConnectivity(profile, { timeoutMs: 200 });
      const duration = Date.now() - start;

      assert.strictEqual(result.ok, false);
      assert.ok(duration < 200 + 3000,
        `expected testConnectivity to abort near timeoutMs=200, took ${duration}ms`);
      assert.ok(requestCount >= 1, "expected the server to have received the request");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
