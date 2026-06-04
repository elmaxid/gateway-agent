import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Point config at a temp directory so we never touch real config
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-cfg-test-"));
process.env.GATEWAY_PLUGIN_CONFIG_DIR = tmpDir;

// Import after env is set so CONFIG_PATH picks up the override
const {
  loadConfig,
  saveConfig,
  resolveProfile,
  resolveTaskProfile,
  addProfile,
  removeProfile,
  validateProfile,
  CONFIG_PATH,
} = await import("../plugins/gateway/scripts/lib/config.mjs");

const VALID_PROFILE = {
  kind: "claude-gateway",
  baseUrl: "https://gw.example.com",
  defaultModel: "claude-sonnet-4-20250514",
};

const OPENAI_PROFILE = {
  kind: "openai-chat",
  baseUrl: "https://api.openai.com",
  defaultModel: "gpt-4o",
};

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    // Ensure clean state
    try { fs.unlinkSync(CONFIG_PATH); } catch {}
    const cfg = loadConfig();
    assert.deepStrictEqual(cfg.profiles, {});
    assert.strictEqual(cfg.defaultProfile, null);
    assert.strictEqual(cfg.reviewProfile, null);
    assert.strictEqual(cfg.taskProfile, null);
  });
});

describe("saveConfig + loadConfig roundtrip", () => {
  it("persists and recovers config", () => {
    const original = {
      profiles: { test: VALID_PROFILE },
      defaultProfile: "test",
      reviewProfile: null,
      taskProfile: "test",
    };
    saveConfig(original);
    const loaded = loadConfig();
    assert.deepStrictEqual(loaded, original);
  });
});

describe("addProfile", () => {
  it("adds a profile to config without mutating original", () => {
    const base = loadConfig();
    const updated = addProfile(base, "new-one", VALID_PROFILE);
    assert.ok(updated.profiles["new-one"]);
    assert.strictEqual(updated.profiles["new-one"].baseUrl, VALID_PROFILE.baseUrl);
    // Original unchanged
    assert.strictEqual(base.profiles["new-one"], undefined);
  });
});

describe("removeProfile", () => {
  it("removes profile and clears matching default/review/task pointers", () => {
    const cfg = {
      profiles: { a: VALID_PROFILE, b: OPENAI_PROFILE },
      defaultProfile: "a",
      reviewProfile: "a",
      taskProfile: "b",
    };
    const updated = removeProfile(cfg, "a");
    assert.strictEqual(updated.profiles.a, undefined);
    assert.ok(updated.profiles.b);
    assert.strictEqual(updated.defaultProfile, null);
    assert.strictEqual(updated.reviewProfile, null);
    // taskProfile pointed at "b", should remain
    assert.strictEqual(updated.taskProfile, "b");
  });
});

describe("resolveProfile", () => {
  it("finds profile by explicit name", () => {
    const cfg = {
      profiles: { myp: VALID_PROFILE },
      defaultProfile: null,
      reviewProfile: null,
      taskProfile: null,
    };
    const p = resolveProfile("myp", cfg);
    assert.strictEqual(p.name, "myp");
    assert.strictEqual(p.baseUrl, VALID_PROFILE.baseUrl);
  });

  it("falls back to defaultProfile when name is falsy", () => {
    const cfg = {
      profiles: { fallback: OPENAI_PROFILE },
      defaultProfile: "fallback",
      reviewProfile: null,
      taskProfile: null,
    };
    const p = resolveProfile(null, cfg);
    assert.strictEqual(p.name, "fallback");
    assert.strictEqual(p.kind, "openai-chat");
  });

  it("throws for missing profile", () => {
    const cfg = {
      profiles: {},
      defaultProfile: null,
      reviewProfile: null,
      taskProfile: null,
    };
    assert.throws(() => resolveProfile("nope", cfg), /not found/);
  });

  it("throws when no name and no default", () => {
    const cfg = {
      profiles: {},
      defaultProfile: null,
      reviewProfile: null,
      taskProfile: null,
    };
    assert.throws(() => resolveProfile(null, cfg), /not found/);
  });
});

describe("resolveTaskProfile", () => {
  it("throws for openai-chat kind", () => {
    const cfg = {
      profiles: { oai: OPENAI_PROFILE },
      defaultProfile: "oai",
      reviewProfile: null,
      taskProfile: null,
    };
    assert.throws(
      () => resolveTaskProfile(cfg),
      /requires kind "claude-gateway"/
    );
  });
});

describe("validateProfile", () => {
  it("rejects missing required fields", () => {
    const result = validateProfile({ kind: "openai-chat" });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => /baseUrl/.test(e)));
    assert.ok(result.errors.some((e) => /defaultModel/.test(e)));
  });

  it("rejects invalid kind", () => {
    const result = validateProfile({
      kind: "unsupported",
      baseUrl: "https://x.com",
      defaultModel: "m",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => /kind/.test(e)));
  });

  it("accepts a valid profile", () => {
    const result = validateProfile(VALID_PROFILE);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it("accepts openai-chat kind with required fields", () => {
    const result = validateProfile(OPENAI_PROFILE);
    assert.strictEqual(result.valid, true);
  });
});
