import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildCodexEnv } from "../plugins/gateway/scripts/lib/codex-harness.mjs";

const CODEX_PROFILE = {
  kind: "openai-chat",
  baseUrl: "https://gw.example.com",
  defaultModel: "gpt-4o",
  apiKey: "test-api-key",
};

// Save and restore env to avoid test pollution
const savedEnv = { ...process.env };
after(() => {
  process.env = savedEnv;
});

// ---------------------------------------------------------------------------
// buildCodexEnv
// ---------------------------------------------------------------------------

describe("buildCodexEnv", () => {
  it("auth keys always win over subprocessEnv", () => {
    const profile = {
      ...CODEX_PROFILE,
      subprocessEnv: {
        OPENAI_BASE_URL: "https://evil-override.example.com",
        OPENAI_API_KEY: "evil-api-key",
      },
    };
    const env = buildCodexEnv(profile);

    // Auth keys from profile always win, subprocessEnv cannot override
    assert.strictEqual(env.OPENAI_BASE_URL, "https://gw.example.com",
      "OPENAI_BASE_URL must come from profile.baseUrl, not subprocessEnv");
    assert.strictEqual(env.OPENAI_API_KEY, "test-api-key",
      "OPENAI_API_KEY must come from profile.apiKey, not subprocessEnv");
  });

  it("picks safe env vars from process.env", () => {
    // Inject sensitive vars that should NOT leak
    process.env.ANTHROPIC_API_KEY = "anthropic-key";
    process.env.ANTHROPIC_BASE_URL = "https://anthropic.example.com";
    process.env.SECRET_SAUCE = "should-not-appear";
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/test";

    const env = buildCodexEnv(CODEX_PROFILE);

    // Sensitive ANTHROPIC_* vars must not appear
    assert.strictEqual(env.ANTHROPIC_API_KEY, undefined,
      "ANTHROPIC_* vars must not leak into codex env");
    assert.strictEqual(env.ANTHROPIC_BASE_URL, undefined,
      "ANTHROPIC_* vars must not leak into codex env");

    // Non-whitelisted custom vars must not appear
    assert.strictEqual(env.SECRET_SAUCE, undefined,
      "Non-whitelisted vars must not appear in env");

    // Whitelisted vars (PATH, HOME) may appear from pickEnv
    assert.strictEqual(env.PATH, "/usr/bin");
    assert.strictEqual(env.HOME, "/home/test");
  });

  it("defaults apiKey to empty string when absent", () => {
    const minimal = {
      kind: "openai-chat",
      baseUrl: "https://gw.example.com",
      defaultModel: "gpt-4o",
      // no apiKey or authToken
    };
    const env = buildCodexEnv(minimal);

    assert.strictEqual(env.OPENAI_API_KEY, "");
  });

  it("falls back to authToken if apiKey is absent", () => {
    const profile = {
      kind: "openai-chat",
      baseUrl: "https://gw.example.com",
      defaultModel: "gpt-4o",
      authToken: "test-auth-token",
    };
    const env = buildCodexEnv(profile);

    assert.strictEqual(env.OPENAI_API_KEY, "test-auth-token");
  });
});
