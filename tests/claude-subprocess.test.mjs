import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { buildSubprocessEnv, runClaudeTask } from "../plugins/gateway/scripts/lib/claude-subprocess.mjs";

const CLAUDE_PROFILE = {
  kind: "claude-gateway",
  baseUrl: "https://gw.example.com",
  defaultModel: "claude-sonnet-4-20250514",
  apiKey: "test-api-key",
  authToken: "test-auth-token",
};

const OPENAI_PROFILE = {
  kind: "openai-chat",
  baseUrl: "https://api.openai.com",
  defaultModel: "gpt-4o",
};

// Save and restore env to avoid test pollution
const savedEnv = { ...process.env };
after(() => {
  process.env = savedEnv;
});

// ---------------------------------------------------------------------------
// buildSubprocessEnv
// ---------------------------------------------------------------------------

describe("buildSubprocessEnv", () => {
  it("picks only whitelisted env vars", () => {
    // Inject a non-whitelisted var
    process.env.SECRET_SAUCE = "should-not-appear";
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/test";

    const env = buildSubprocessEnv(CLAUDE_PROFILE);

    assert.strictEqual(env.PATH, "/usr/bin");
    assert.strictEqual(env.HOME, "/home/test");
    assert.strictEqual(env.SECRET_SAUCE, undefined,
      "Non-whitelisted vars must not appear in subprocess env");
  });

  it("passes through XDG_ prefixed vars", () => {
    process.env.XDG_CONFIG_HOME = "/home/test/.config";
    process.env.XDG_DATA_HOME = "/home/test/.local/share";

    const env = buildSubprocessEnv(CLAUDE_PROFILE);

    assert.strictEqual(env.XDG_CONFIG_HOME, "/home/test/.config");
    assert.strictEqual(env.XDG_DATA_HOME, "/home/test/.local/share");
  });

  it("overlays Anthropic values from profile", () => {
    const env = buildSubprocessEnv(CLAUDE_PROFILE);

    assert.strictEqual(env.ANTHROPIC_BASE_URL, "https://gw.example.com");
    assert.strictEqual(env.ANTHROPIC_API_KEY, "test-api-key");
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, "test-auth-token");
  });

  it("falls back to authToken if apiKey is absent", () => {
    const profile = {
      kind: "claude-gateway",
      baseUrl: "https://gw.example.com",
      defaultModel: "glm-5.2",
      authToken: "sk-gateway-key",
    };
    const env = buildSubprocessEnv(profile);

    assert.strictEqual(env.ANTHROPIC_API_KEY, "sk-gateway-key",
      "ANTHROPIC_API_KEY must fall back to authToken so subprocess authenticates to gateway");
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, "sk-gateway-key");
  });

  it("defaults apiKey and authToken to empty string when absent", () => {
    const minimal = {
      kind: "claude-gateway",
      baseUrl: "https://gw.example.com",
      defaultModel: "m",
    };
    const env = buildSubprocessEnv(minimal);

    assert.strictEqual(env.ANTHROPIC_API_KEY, "");
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, "");
  });

  it("spreads subprocessEnv from profile", () => {
    const profile = {
      ...CLAUDE_PROFILE,
      subprocessEnv: {
        CUSTOM_VAR: "custom-value",
        ANOTHER: "another-value",
      },
    };
    const env = buildSubprocessEnv(profile);

    assert.strictEqual(env.CUSTOM_VAR, "custom-value");
    assert.strictEqual(env.ANOTHER, "another-value");
  });

  it("auth keys always win over subprocessEnv", () => {
    const profile = {
      ...CLAUDE_PROFILE,
      subprocessEnv: {
        ANTHROPIC_BASE_URL: "https://override.example.com",
        ANTHROPIC_API_KEY: "evil-api-key",
        ANTHROPIC_AUTH_TOKEN: "evil-auth-token",
      },
    };
    const env = buildSubprocessEnv(profile);

    // Auth keys from profile always win, subprocessEnv cannot override
    assert.strictEqual(env.ANTHROPIC_BASE_URL, "https://gw.example.com");
    assert.strictEqual(env.ANTHROPIC_API_KEY, "test-api-key");
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, "test-auth-token");
  });
});

// ---------------------------------------------------------------------------
// runClaudeTask
// ---------------------------------------------------------------------------

describe("runClaudeTask", () => {
  it("throws for non-claude-gateway profiles", () => {
    assert.throws(
      () => runClaudeTask(OPENAI_PROFILE, "do something"),
      /cannot run tasks.*Requires "claude-gateway"/i
    );
  });

  it("throws with profile kind in the error message", () => {
    try {
      runClaudeTask(OPENAI_PROFILE, "do something");
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("openai-chat"),
        "Error should mention the actual profile kind");
    }
  });
});
