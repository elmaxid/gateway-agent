import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  READ_TOOLS,
  WRITE_TOOLS,
  getZeroConfigPath,
  getZeroProvider,
  _resetZeroProviderCache,
  buildZeroEnv,
  buildZeroArgs,
  urlsMatch,
  parseZeroJsonl,
  shapeZeroResult,
  zeroPreflightError,
  runZeroTask
} from "../plugins/gateway/scripts/lib/zero-harness.mjs";

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
// parseZeroJsonl
// ---------------------------------------------------------------------------

describe("parseZeroJsonl", () => {
  it("extracts final text and usage from a clean stream", () => {
    const raw = [
      '{"type":"run_start","model":"glm-5.2"}',
      '{"type":"text","delta":"AN"}',
      '{"type":"usage","prompt_tokens":100,"completion_tokens":5,"total_tokens":105}',
      '{"type":"final","text":"ANSWER"}',
      '{"type":"done","exit_code":0}'
    ].join("\n");
    const p = parseZeroJsonl(raw);
    assert.equal(p.hasFinal, true);
    assert.equal(p.finalText, "ANSWER");
    assert.deepEqual(p.usage, { promptTokens: 100, completionTokens: 5, totalTokens: 105 });
    assert.deepEqual(p.errorLines, []);
  });

  it("last final wins when multiple finals appear", () => {
    const raw = '{"type":"final","text":"first"}\n{"type":"final","text":"second"}';
    assert.equal(parseZeroJsonl(raw).finalText, "second");
  });

  it("empty final text is a valid empty answer, not a missing final", () => {
    const p = parseZeroJsonl('{"type":"final","text":""}');
    assert.equal(p.hasFinal, true);
    assert.equal(p.finalText, "");
  });

  it("no final event → hasFinal false", () => {
    const p = parseZeroJsonl('{"type":"text","delta":"x"}');
    assert.equal(p.hasFinal, false);
    assert.equal(p.finalText, null);
  });

  it("error events are collected even when a final exists", () => {
    const raw = [
      '{"type":"final","text":"ok"}',
      '{"type":"error","code":"provider_error","message":"rate limited"}'
    ].join("\n");
    const p = parseZeroJsonl(raw);
    assert.equal(p.finalText, "ok");
    assert.deepEqual(p.errorLines, ["[zero error provider_error] rate limited"]);
  });

  it("error event without code gets 'unknown'", () => {
    const p = parseZeroJsonl('{"type":"error","message":"boom"}');
    assert.deepEqual(p.errorLines, ["[zero error unknown] boom"]);
  });

  it("skips corrupt lines and trailing partial lines without throwing", () => {
    const raw = 'not-json\n{"type":"final","text":"ok"}\n{"type":"usa';
    const p = parseZeroJsonl(raw);
    assert.equal(p.finalText, "ok");
  });

  it("handles CRLF line endings", () => {
    const raw = '{"type":"final","text":"crlf-ok"}\r\n{"type":"done","exit_code":0}\r\n';
    assert.equal(parseZeroJsonl(raw).finalText, "crlf-ok");
  });

  it("tolerates schemaVersion (stream-json shape) and unknown event types", () => {
    const raw = [
      '{"schemaVersion":2,"type":"weird_event","x":1}',
      '{"schemaVersion":2,"type":"usage","promptTokens":7,"completionTokens":3,"totalTokens":10}',
      '{"schemaVersion":2,"type":"final","text":"v2"}'
    ].join("\n");
    const p = parseZeroJsonl(raw);
    assert.equal(p.finalText, "v2");
    assert.deepEqual(p.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });

  it("empty/null input → no final, no usage", () => {
    assert.equal(parseZeroJsonl("").hasFinal, false);
    assert.equal(parseZeroJsonl(null).usage, null);
  });
});

// ---------------------------------------------------------------------------
// buildZeroEnv — security ordering
// ---------------------------------------------------------------------------

describe("buildZeroEnv", () => {
  it("profile credential wins over subprocessEnv override attempt", () => {
    const profile = {
      ...PROFILE,
      subprocessEnv: { GATEWAY_API_KEY: "evil-key" }
    };
    const env = buildZeroEnv(profile, null);
    assert.equal(env.GATEWAY_API_KEY, "test-token");
  });

  it("honors the provider's configured apiKeyEnv name", () => {
    const env = buildZeroEnv(PROFILE, { apiKeyEnv: "MY_ZERO_KEY" });
    assert.equal(env.MY_ZERO_KEY, "test-token");
    assert.equal(env.GATEWAY_API_KEY, undefined);
  });

  it("prefers apiKey over authToken when both set", () => {
    const env = buildZeroEnv({ ...PROFILE, apiKey: "k1" }, null);
    assert.equal(env.GATEWAY_API_KEY, "k1");
  });
});

// ---------------------------------------------------------------------------
// buildZeroArgs
// ---------------------------------------------------------------------------

describe("buildZeroArgs", () => {
  it("read mode: auto low + READ_TOOLS only", () => {
    const args = buildZeroArgs("glm-5.2", { write: false, promptFile: "/tmp/p.md" });
    assert.deepEqual(args, [
      "exec", "-o", "json", "-m", "glm-5.2", "-f", "/tmp/p.md",
      "--enabled-tools", READ_TOOLS.join(","),
      "--auto", "low"
    ]);
  });

  it("write mode: auto medium + skip-permissions + READ+WRITE tools + cwd", () => {
    const args = buildZeroArgs("glm-5.2", { write: true, cwd: "/work", promptFile: "/tmp/p.md" });
    assert.deepEqual(args, [
      "exec", "-o", "json", "-m", "glm-5.2", "-f", "/tmp/p.md",
      "--enabled-tools", [...READ_TOOLS, ...WRITE_TOOLS].join(","),
      "--auto", "medium", "--skip-permissions-unsafe",
      "-C", "/work"
    ]);
  });
});

// ---------------------------------------------------------------------------
// urlsMatch
// ---------------------------------------------------------------------------

describe("urlsMatch", () => {
  it("ignores trailing slashes, case, and default ports", () => {
    assert.equal(urlsMatch("http://Host:4000/", "http://host:4000"), true);
    assert.equal(urlsMatch("https://a.example.com", "https://a.example.com:443/"), true);
  });
  it("different host or port → false", () => {
    assert.equal(urlsMatch("http://a:4000", "http://b:4000"), false);
    assert.equal(urlsMatch("http://a:4000", "http://a:5000"), false);
  });
});

// ---------------------------------------------------------------------------
// getZeroProvider — file resolution + cache
// ---------------------------------------------------------------------------

describe("getZeroProvider", () => {
  let tmpDir;

  function writeZeroConfig(obj) {
    fs.mkdirSync(path.join(tmpDir, "zero"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "zero", "config.json"), JSON.stringify(obj));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-harness-test-"));
    process.env.XDG_CONFIG_HOME = tmpDir;
    _resetZeroProviderCache();
  });

  it("resolves config path under XDG_CONFIG_HOME", () => {
    assert.equal(getZeroConfigPath(), path.join(tmpDir, "zero", "config.json"));
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(getZeroConfigPath(), path.join(os.homedir(), ".config", "zero", "config.json"));
    process.env.XDG_CONFIG_HOME = tmpDir;
  });

  it("returns the active provider with normalized fields", () => {
    writeZeroConfig({
      activeProvider: "gw",
      providers: [{ name: "gw", provider_kind: "openai-compatible", baseURL: "http://x:1", model: "m1", apiKeyEnv: "K" }]
    });
    const p = getZeroProvider();
    assert.deepEqual(p, {
      name: "gw", baseURL: "http://x:1", model: "m1",
      apiKeyEnv: "K", apiKeyStored: false, providerKind: "openai-compatible"
    });
  });

  it("missing file / malformed JSON / empty object → null", () => {
    assert.equal(getZeroProvider(), null);
    _resetZeroProviderCache();
    fs.mkdirSync(path.join(tmpDir, "zero"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "zero", "config.json"), "{not json");
    assert.equal(getZeroProvider(), null);
    _resetZeroProviderCache();
    writeZeroConfig({});
    assert.equal(getZeroProvider(), null);
  });

  it("caches per process; refresh:true re-reads", () => {
    writeZeroConfig({ activeProvider: "a", providers: [{ name: "a", baseURL: "http://one:1" }] });
    assert.equal(getZeroProvider().baseURL, "http://one:1");
    writeZeroConfig({ activeProvider: "a", providers: [{ name: "a", baseURL: "http://two:2" }] });
    assert.equal(getZeroProvider().baseURL, "http://one:1"); // cached
    assert.equal(getZeroProvider({ refresh: true }).baseURL, "http://two:2");
  });
});

// ---------------------------------------------------------------------------
// zeroPreflightError
// ---------------------------------------------------------------------------

describe("zeroPreflightError", () => {
  it("null provider → remediation mentioning setup zero-init", () => {
    const msg = zeroPreflightError(PROFILE, null);
    assert.match(msg, /setup zero-init/);
  });
  it("URL mismatch → names both URLs", () => {
    const msg = zeroPreflightError(PROFILE, { name: "gw", baseURL: "http://other:9" });
    assert.match(msg, /http:\/\/other:9/);
    assert.match(msg, /192\.0\.2\.10:4000/);
  });
  it("aligned provider → null", () => {
    assert.equal(zeroPreflightError(PROFILE, { name: "gw", baseURL: "http://192.0.2.10:4000/" }), null);
  });
});

// ---------------------------------------------------------------------------
// shapeZeroResult — result contract (spec §3.4), pure — no spawn needed
// ---------------------------------------------------------------------------

describe("shapeZeroResult", () => {
  it("normalizes null exit code (signal kill) to 1 — never a downstream success", () => {
    const r = shapeZeroResult({ code: null, signal: "SIGTERM", stdout: '{"type":"text","delta":"x"}', stderr: "" });
    assert.equal(r.exitCode, 1);
    assert.equal(r.signal, "SIGTERM");
  });

  it("happy path: stdout is the final text, rawJsonl keeps the stream", () => {
    const raw = '{"type":"final","text":"ANSWER"}\n{"type":"done","exit_code":0}';
    const r = shapeZeroResult({ code: 0, signal: null, stdout: raw, stderr: "" });
    assert.equal(r.stdout, "ANSWER");
    assert.equal(r.rawJsonl, raw);
    assert.equal(r.exitCode, 0);
  });

  it("error events reach stderr even when a final exists", () => {
    const raw = '{"type":"final","text":"ok"}\n{"type":"error","code":"provider_error","message":"boom"}';
    const r = shapeZeroResult({ code: 0, signal: null, stdout: raw, stderr: "" });
    assert.equal(r.stdout, "ok");
    assert.match(r.stderr, /\[zero error provider_error\] boom/);
  });

  it("no final → empty stdout, extracted error + loud note on stderr, rawJsonl keeps the stream", () => {
    const raw = '{"type":"error","code":"provider_error","message":"no key"}';
    const r = shapeZeroResult({ code: 3, signal: null, stdout: raw, stderr: "" });
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /\[zero error provider_error\]/);
    assert.match(r.stderr, /no final message/);
    assert.equal(r.rawJsonl, raw);
    assert.equal(r.exitCode, 3);
  });

  it("empty final text is a valid answer — no fallback note", () => {
    const r = shapeZeroResult({ code: 0, signal: null, stdout: '{"type":"final","text":""}', stderr: "" });
    assert.equal(r.stdout, "");
    assert.ok(!r.stderr.includes("no final message"));
  });

  it("exit 0 with no final event is anomalous — never reads as success", () => {
    const r = shapeZeroResult({ code: 0, signal: null, stdout: '{"type":"text","delta":"x"}', stderr: "" });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /no final message/);
  });
});

// ---------------------------------------------------------------------------
// runZeroTask — preflight and guards
// ---------------------------------------------------------------------------

describe("runZeroTask preflight and guards", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-harness-run-"));
    process.env.XDG_CONFIG_HOME = tmpDir;
    _resetZeroProviderCache();
  });

  it("rejects resume/fork with an explicit error", async () => {
    await assert.rejects(
      () => runZeroTask(PROFILE, "hi", { resume: true }),
      /does not support resume\/fork/
    );
    await assert.rejects(
      () => runZeroTask(PROFILE, "hi", { fork: "abc" }),
      /does not support resume\/fork/
    );
  });

  it("resolves exitCode 1 with remediation when no provider configured (no spawn)", async () => {
    const result = await runZeroTask(PROFILE, "hi", {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /setup zero-init/);
    assert.equal(result.rawJsonl, "");
    assert.equal(result.usage, null);
  });

  it("resolves exitCode 1 on provider URL mismatch (no spawn)", async () => {
    fs.mkdirSync(path.join(tmpDir, "zero"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "zero", "config.json"),
      JSON.stringify({ activeProvider: "gw", providers: [{ name: "gw", baseURL: "http://elsewhere:9" }] })
    );
    const result = await runZeroTask(PROFILE, "hi", {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /elsewhere:9/);
  });

  it("captures the full raw stream even when zero exits immediately after a large write (close, not exit)", async () => {
    // aligned provider — preflight passes and runZeroTask actually spawns `zero`
    fs.mkdirSync(path.join(tmpDir, "zero"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "zero", "config.json"),
      JSON.stringify({ activeProvider: "gw", providers: [{ name: "gw", baseURL: PROFILE.baseUrl }] })
    );
    _resetZeroProviderCache();

    // fake `zero` emits a large `final` event then exits non-zero right away.
    // Settling on "exit" could truncate the JSONL before the terminal line,
    // making parseZeroJsonl miss the final; "close" guarantees full capture.
    const big = "X".repeat(60000);
    const finalLine = JSON.stringify({ type: "final", text: big });
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-fake-"));
    const fakeZeroPath = path.join(fakeBinDir, "zero");
    fs.writeFileSync(fakeZeroPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(finalLine)} + "\\n", () => process.exit(1));\n`);
    fs.chmodSync(fakeZeroPath, 0o755);

    const originalPath = process.env.PATH;
    const NODE_BIN_DIR = path.dirname(process.execPath);
    process.env.PATH = [fakeBinDir, NODE_BIN_DIR, originalPath ?? ""].filter(Boolean).join(path.delimiter);
    try {
      const result = await runZeroTask(PROFILE, "hi", { write: false });
      assert.equal(result.exitCode, 1, "non-zero exit must be preserved");
      // Full final text survived → the raw stream was captured completely.
      assert.equal(result.stdout.length, 60000, `expected full capture, got ${result.stdout.length} chars`);
      assert.ok(result.rawJsonl.includes(big), "rawJsonl must retain the complete stream");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("kills the spawned process tree immediately when the signal is already aborted", async () => {
    // aligned provider — preflight passes and runZeroTask actually spawns `zero`
    fs.mkdirSync(path.join(tmpDir, "zero"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "zero", "config.json"),
      JSON.stringify({ activeProvider: "gw", providers: [{ name: "gw", baseURL: PROFILE.baseUrl }] })
    );
    _resetZeroProviderCache();

    // fake `zero` binary that sleeps long enough to prove a real kill happened
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-harness-fakebin-"));
    const fakeZeroPath = path.join(fakeBinDir, "zero");
    fs.writeFileSync(fakeZeroPath, "#!/bin/sh\nsleep 30\n");
    fs.chmodSync(fakeZeroPath, 0o755);

    // buildZeroEnv -> pickEnv copies PATH from process.env, so prepending here reaches the child
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

    try {
      const deadlineMs = 10000;
      const deadline = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`runZeroTask did not settle within ${deadlineMs}ms — already-aborted signal was ignored`)),
          deadlineMs
        )
      );
      const start = Date.now();
      const result = await Promise.race([
        runZeroTask(PROFILE, "hi", { signal: AbortSignal.abort() }),
        deadline
      ]);
      const elapsed = Date.now() - start;
      // terminateProcessTree blocks ~2s synchronously (SIGTERM grace) — expected, well under the deadline
      assert.ok(elapsed < deadlineMs, `expected a fast settle, took ${elapsed}ms`);
      assert.equal(result.exitCode, 1); // signal-kill normalizes null exit code -> 1
      assert.ok(result.signal, `expected a non-null kill signal, got ${result.signal}`);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
