import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  KIMI_PROVIDER,
  isKimiAvailable,
  getKimiConfigPath,
  readKimiConfig,
  getKimiProviderBaseUrl,
  getKimiProviderApiKey,
  kimiModelDeclared,
  kimiPreflightError,
  buildKimiEnv,
  buildKimiArgs,
  parseKimiStream,
  shapeKimiResult,
  runKimiTask
} from "../plugins/gateway/scripts/lib/kimi-harness.mjs";

const PROFILE = {
  name: "glm",
  kind: "claude-gateway",
  baseUrl: "http://192.0.2.10:4000",
  defaultModel: "glm-5.2",
  authToken: "test-token"
};

const savedEnv = { ...process.env };
after(() => {
  process.env = savedEnv;
});

// ---------------------------------------------------------------------------
// parseKimiStream
// ---------------------------------------------------------------------------

describe("parseKimiStream", () => {
  it("extracts the final assistant text from a clean stream", () => {
    const raw = [
      '{"role":"assistant","content":"ANSWER"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"s1"}'
    ].join("\n");
    const p = parseKimiStream(raw);
    assert.equal(p.hasFinal, true);
    assert.equal(p.finalText, "ANSWER");
  });

  it("tool-calling turns (no content key) are not mistaken for the final", () => {
    const raw = [
      '{"role":"assistant","tool_calls":[{"function":{"name":"Read"}}]}',
      '{"role":"tool","content":"file bytes"}',
      '{"role":"assistant","content":"final answer"}'
    ].join("\n");
    const p = parseKimiStream(raw);
    assert.equal(p.finalText, "final answer");
  });

  it("last final wins when multiple assistant content lines appear", () => {
    const raw = '{"role":"assistant","content":"first"}\n{"role":"assistant","content":"second"}';
    assert.equal(parseKimiStream(raw).finalText, "second");
  });

  it("empty final text is a valid empty answer, not a missing final", () => {
    const p = parseKimiStream('{"role":"assistant","content":""}');
    assert.equal(p.hasFinal, true);
    assert.equal(p.finalText, "");
  });

  it("no assistant-content event → hasFinal false", () => {
    const p = parseKimiStream('{"role":"assistant","tool_calls":[]}');
    assert.equal(p.hasFinal, false);
    assert.equal(p.finalText, null);
  });

  it("skips corrupt lines and trailing partial lines without throwing", () => {
    const raw = 'not-json\n{"role":"assistant","content":"ok"}\n{"role":"me';
    assert.equal(parseKimiStream(raw).finalText, "ok");
  });

  it("empty/null input → no final", () => {
    assert.equal(parseKimiStream("").hasFinal, false);
    assert.equal(parseKimiStream(null).hasFinal, false);
  });
});

// ---------------------------------------------------------------------------
// buildKimiEnv — no credential injection
// ---------------------------------------------------------------------------

describe("buildKimiEnv", () => {
  it("does not inject any API key (kimi reads it from config.toml)", () => {
    const env = buildKimiEnv(PROFILE);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.GATEWAY_API_KEY, undefined);
  });

  it("still copies through the whitelisted subprocessEnv overrides", () => {
    const env = buildKimiEnv({ ...PROFILE, subprocessEnv: { NODE_PATH: "/custom" } });
    assert.equal(env.NODE_PATH, "/custom");
  });
});

// ---------------------------------------------------------------------------
// buildKimiArgs
// ---------------------------------------------------------------------------

describe("buildKimiArgs", () => {
  it("plain run: prompt as argv value, provider-prefixed model, stream-json", () => {
    const args = buildKimiArgs("kimi-k2.6", "hello", {});
    assert.deepEqual(args, ["-p", "hello", "-m", "gateway/kimi-k2.6", "--output-format", "stream-json"]);
  });

  it("resume: appends -c", () => {
    const args = buildKimiArgs("kimi-k2.6", "hello", { resume: true });
    assert.deepEqual(args, ["-p", "hello", "-m", "gateway/kimi-k2.6", "--output-format", "stream-json", "-c"]);
  });
});

// ---------------------------------------------------------------------------
// TOML reading — getKimiConfigPath / getKimiProviderBaseUrl / kimiModelDeclared
// ---------------------------------------------------------------------------

describe("getKimiConfigPath", () => {
  it("resolves under HOME/.kimi-code/config.toml", () => {
    assert.equal(getKimiConfigPath({ HOME: "/fake/home" }), path.join("/fake/home", ".kimi-code", "config.toml"));
  });
});

describe("getKimiProviderBaseUrl / kimiModelDeclared", () => {
  const CONFIG = [
    'default_model = "gateway/kimi-k2.6"',
    "",
    "[[hooks]]",
    'event = "UserPromptSubmit"',
    'command = "true"',
    "",
    "[providers.gateway]",
    'type = "openai"',
    'base_url = "http://192.0.2.10:4000/v1"',
    'api_key = "sk-test"',
    "",
    '[models."gateway/kimi-k2.6"]',
    'provider = "gateway"',
    'model = "kimi-k2.6"'
  ].join("\n");

  it("extracts base_url from the named provider section", () => {
    assert.equal(getKimiProviderBaseUrl(CONFIG), "http://192.0.2.10:4000/v1");
  });

  it("[[array.tables]] headers like [[hooks]] never get mistaken for a section", () => {
    assert.equal(getKimiProviderBaseUrl(CONFIG, "hooks"), null);
  });

  it("missing provider section → null", () => {
    assert.equal(getKimiProviderBaseUrl(CONFIG, "nope"), null);
  });

  it("non-string config → null", () => {
    assert.equal(getKimiProviderBaseUrl(null), null);
  });

  it("declared model key found; undeclared not found", () => {
    assert.equal(kimiModelDeclared(CONFIG, "gateway/kimi-k2.6"), true);
    assert.equal(kimiModelDeclared(CONFIG, "gateway/does-not-exist"), false);
  });

  it("getKimiProviderApiKey extracts the inline credential", () => {
    assert.equal(getKimiProviderApiKey(CONFIG), "sk-test");
    assert.equal(getKimiProviderApiKey(CONFIG, "nope"), null);
    assert.equal(getKimiProviderApiKey(null), null);
  });

  it("tolerates a trailing comment on the section header", () => {
    const config = '[providers.gateway] # active\nbase_url = "http://x:1"';
    assert.equal(getKimiProviderBaseUrl(config), "http://x:1");
  });

  it("accepts single-quoted (TOML literal string) values too", () => {
    const config = "[providers.gateway]\nbase_url = 'http://x:1'\napi_key = 'sk-literal'";
    assert.equal(getKimiProviderBaseUrl(config), "http://x:1");
    assert.equal(getKimiProviderApiKey(config), "sk-literal");
  });
});

// ---------------------------------------------------------------------------
// kimiPreflightError
// ---------------------------------------------------------------------------

describe("kimiPreflightError", () => {
  const ALIGNED_CONFIG = [
    "[providers.gateway]",
    'base_url = "http://192.0.2.10:4000"',
    "",
    '[models."gateway/glm-5.2"]',
    'model = "glm-5.2"'
  ].join("\n");

  it("null config text → remediation mentioning config.toml", () => {
    const msg = kimiPreflightError(PROFILE, "glm-5.2", null);
    assert.match(msg, /config\.toml/);
  });

  it("missing provider section → remediation naming the section", () => {
    const msg = kimiPreflightError(PROFILE, "glm-5.2", "default_model = \"x\"");
    assert.match(msg, /\[providers\.gateway\]/);
  });

  it("URL mismatch → names both URLs", () => {
    const config = '[providers.gateway]\nbase_url = "http://other:9"';
    const msg = kimiPreflightError(PROFILE, "glm-5.2", config);
    assert.match(msg, /http:\/\/other:9/);
    assert.match(msg, /192\.0\.2\.10:4000/);
  });

  it("a /v1 suffix on kimi's base_url (its own OpenAI-SDK convention) is NOT a mismatch — real-world config shape", () => {
    const config = [
      '[providers.gateway]',
      'base_url = "http://192.0.2.10:4000/v1"',
      "",
      '[models."gateway/glm-5.2"]',
      'model = "glm-5.2"'
    ].join("\n");
    assert.equal(kimiPreflightError(PROFILE, "glm-5.2", config), null);
  });

  it("undeclared model → names the expected model key", () => {
    const config = '[providers.gateway]\nbase_url = "http://192.0.2.10:4000"';
    const msg = kimiPreflightError(PROFILE, "glm-5.2", config);
    assert.match(msg, /gateway\/glm-5\.2/);
  });

  it("aligned config with declared model → null", () => {
    assert.equal(kimiPreflightError(PROFILE, "glm-5.2", ALIGNED_CONFIG), null);
  });

  it("a kimi provider repointed at a different path on the same host:port still fails (path is not ignored outright)", () => {
    const config = '[providers.gateway]\nbase_url = "http://192.0.2.10:4000/tenant-b"';
    const msg = kimiPreflightError(PROFILE, "glm-5.2", config);
    assert.match(msg, /http:\/\/192\.0\.2\.10:4000/);
  });

  it("mismatch message shows origin only — never a raw URL that could carry userinfo/query", () => {
    const config = '[providers.gateway]\nbase_url = "http://user:secret@other:9/v1?token=abc"';
    const msg = kimiPreflightError(PROFILE, "glm-5.2", config);
    assert.ok(!msg.includes("secret"), `leaked credential into message: ${msg}`);
    assert.ok(!msg.includes("token=abc"), `leaked query token into message: ${msg}`);
    assert.match(msg, /http:\/\/other:9/);
  });
});

// ---------------------------------------------------------------------------
// shapeKimiResult — result contract, pure — no spawn needed
// ---------------------------------------------------------------------------

describe("shapeKimiResult", () => {
  it("happy path: stdout is the final text, rawJsonl keeps the stream", () => {
    const raw = '{"role":"assistant","content":"ANSWER"}';
    const r = shapeKimiResult({ code: 0, signal: null, stdout: raw, stderr: "" });
    assert.equal(r.stdout, "ANSWER");
    assert.equal(r.rawJsonl, raw);
    assert.equal(r.exitCode, 0);
  });

  it("exit 0 with no final event is anomalous — never reads as success", () => {
    const r = shapeKimiResult({ code: 0, signal: null, stdout: '{"role":"assistant","tool_calls":[]}', stderr: "" });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /no final assistant message/);
  });

  it("ordinary CLI-usage error (non-zero exit, no JSON stream) leaves stderr untouched", () => {
    const r = shapeKimiResult({ code: 1, signal: null, stdout: "", stderr: "error: config.invalid: bad model" });
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "error: config.invalid: bad model");
    assert.ok(!r.stderr.includes("no final assistant message"));
    assert.equal(r.exitCode, 1);
  });

  it("null exit code (signal kill) normalizes to 1", () => {
    const r = shapeKimiResult({ code: null, signal: "SIGTERM", stdout: "", stderr: "" });
    assert.equal(r.exitCode, 1);
    assert.equal(r.signal, "SIGTERM");
  });

  it("empty final text is a valid answer — no anomaly note", () => {
    const r = shapeKimiResult({ code: 0, signal: null, stdout: '{"role":"assistant","content":""}', stderr: "" });
    assert.equal(r.stdout, "");
    assert.ok(!r.stderr.includes("no final assistant message"));
  });
});

// ---------------------------------------------------------------------------
// runKimiTask — guards, preflight, and real spawn against a fake binary
// ---------------------------------------------------------------------------

describe("runKimiTask", () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-harness-test-"));
    process.env.HOME = tmpHome;
  });

  it("rejects fork with an explicit error", async () => {
    await assert.rejects(() => runKimiTask(PROFILE, "hi", { fork: "abc" }), /does not support fork/);
  });

  it("rejects write:false with an explicit error (no CLI-level read-only mode)", async () => {
    await assert.rejects(() => runKimiTask(PROFILE, "hi", { write: false }), /does not support --no-write/);
  });

  it("resolves exitCode 1 with remediation when config.toml is missing (no spawn)", async () => {
    const result = await runKimiTask(PROFILE, "hi", {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /config\.toml/);
    assert.equal(result.rawJsonl, "");
  });

  it("resolves exitCode 1 on provider URL mismatch (no spawn)", async () => {
    const configDir = path.join(tmpHome, ".kimi-code");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.toml"), '[providers.gateway]\nbase_url = "http://elsewhere:9"');
    const result = await runKimiTask(PROFILE, "hi", {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /elsewhere:9/);
  });

  it("spawns kimi and captures the full stream (close, not exit)", async () => {
    const configDir = path.join(tmpHome, ".kimi-code");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.toml"),
      `[providers.gateway]\nbase_url = "${PROFILE.baseUrl}"\n\n[models."gateway/${PROFILE.defaultModel}"]\nmodel = "${PROFILE.defaultModel}"`
    );

    // fake `kimi` emits a large final line then exits non-zero right away —
    // settling on "exit" could truncate before the terminal line.
    const big = "X".repeat(60000);
    const finalLine = JSON.stringify({ role: "assistant", content: big });
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-fake-"));
    const fakeKimiPath = path.join(fakeBinDir, "kimi");
    fs.writeFileSync(fakeKimiPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(finalLine)} + "\\n", () => process.exit(1));\n`);
    fs.chmodSync(fakeKimiPath, 0o755);

    const originalPath = process.env.PATH;
    const NODE_BIN_DIR = path.dirname(process.execPath);
    process.env.PATH = [fakeBinDir, NODE_BIN_DIR, originalPath ?? ""].filter(Boolean).join(path.delimiter);
    try {
      const result = await runKimiTask(PROFILE, "hi", {});
      assert.equal(result.exitCode, 1, "non-zero exit must be preserved");
      assert.equal(result.stdout.length, 60000, `expected full capture, got ${result.stdout.length} chars`);
      assert.ok(result.rawJsonl.includes(big), "rawJsonl must retain the complete stream");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("kills the spawned process tree immediately when the signal is already aborted", async () => {
    const configDir = path.join(tmpHome, ".kimi-code");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.toml"),
      `[providers.gateway]\nbase_url = "${PROFILE.baseUrl}"\n\n[models."gateway/${PROFILE.defaultModel}"]\nmodel = "${PROFILE.defaultModel}"`
    );

    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-harness-fakebin-"));
    const fakeKimiPath = path.join(fakeBinDir, "kimi");
    fs.writeFileSync(fakeKimiPath, "#!/bin/sh\nsleep 30\n");
    fs.chmodSync(fakeKimiPath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

    try {
      const deadlineMs = 10000;
      const deadline = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`runKimiTask did not settle within ${deadlineMs}ms — already-aborted signal was ignored`)),
          deadlineMs
        )
      );
      const start = Date.now();
      const result = await Promise.race([
        runKimiTask(PROFILE, "hi", { signal: AbortSignal.abort() }),
        deadline
      ]);
      const elapsed = Date.now() - start;
      assert.ok(elapsed < deadlineMs, `expected a fast settle, took ${elapsed}ms`);
      assert.equal(result.exitCode, 1);
      assert.ok(result.signal, `expected a non-null kill signal, got ${result.signal}`);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ---------------------------------------------------------------------------
// isKimiAvailable — smoke check only (real binary presence varies by machine)
// ---------------------------------------------------------------------------

describe("isKimiAvailable", () => {
  it("returns a boolean", () => {
    assert.equal(typeof isKimiAvailable(), "boolean");
  });
});
