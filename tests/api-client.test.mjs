import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
