import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLINE_PROVIDER,
  isClineAvailable,
  getClineConfigPath,
  readClineConfig,
  getClineProviderBaseUrl,
  getClineProviderApiKey,
  clinePreflightError,
  buildClineEnv,
  buildClineArgs,
  parseClineStream,
  shapeClineResult,
  runClineTask
} from "../plugins/gateway/scripts/lib/cline-harness.mjs";

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

function providersJson(overrides = {}) {
  return JSON.stringify({
    version: 1,
    lastUsedProvider: "litellm",
    providers: {
      litellm: {
        settings: {
          provider: "litellm",
          apiKey: "sk-test",
          model: "glm-5.2",
          baseUrl: "http://192.0.2.10:4000/v1",
          ...overrides
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// parseClineStream
// ---------------------------------------------------------------------------

describe("parseClineStream", () => {
  it("extracts text from the last run_result event", () => {
    const raw = [
      '{"type":"hook_event","hookEventName":"agent_start"}',
      '{"type":"agent_event","event":{"type":"content_start","contentType":"text","text":"hi"}}',
      '{"type":"run_result","finishReason":"completed","text":"ANSWER"}'
    ].join("\n");
    const p = parseClineStream(raw);
    assert.equal(p.hasFinal, true);
    assert.equal(p.finalText, "ANSWER");
    assert.equal(p.finishReason, "completed");
  });

  it("last run_result wins when multiple appear", () => {
    const raw = '{"type":"run_result","finishReason":"completed","text":"first"}\n{"type":"run_result","finishReason":"completed","text":"second"}';
    assert.equal(parseClineStream(raw).finalText, "second");
  });

  it("empty final text is a valid empty answer when finishReason is completed", () => {
    const p = parseClineStream('{"type":"run_result","finishReason":"completed","text":""}');
    assert.equal(p.hasFinal, true);
    assert.equal(p.finalText, "");
  });

  it("a run_result with finishReason \"aborted\" is NOT trusted even with empty text — real bug: aborted runs can look like a valid empty answer", () => {
    const p = parseClineStream('{"type":"run_result","finishReason":"aborted","text":""}');
    assert.equal(p.hasFinal, false);
    assert.equal(p.finalText, null);
    assert.equal(p.finishReason, "aborted");
  });

  it("no run_result event → hasFinal false", () => {
    const p = parseClineStream('{"type":"agent_event","event":{"type":"iteration_start"}}');
    assert.equal(p.hasFinal, false);
    assert.equal(p.finalText, null);
  });

  it("skips corrupt lines and trailing partial lines without throwing", () => {
    const raw = 'not-json\n{"type":"run_result","finishReason":"completed","text":"ok"}\n{"type":"run_r';
    assert.equal(parseClineStream(raw).finalText, "ok");
  });

  it("empty/null input → no final", () => {
    assert.equal(parseClineStream("").hasFinal, false);
    assert.equal(parseClineStream(null).hasFinal, false);
  });
});

// ---------------------------------------------------------------------------
// buildClineEnv — no credential injection
// ---------------------------------------------------------------------------

describe("buildClineEnv", () => {
  it("does not inject any API key (cline reads it from providers.json)", () => {
    const env = buildClineEnv(PROFILE);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.GATEWAY_API_KEY, undefined);
  });

  it("still copies through the whitelisted subprocessEnv overrides", () => {
    const env = buildClineEnv({ ...PROFILE, subprocessEnv: { NODE_PATH: "/custom" } });
    assert.equal(env.NODE_PATH, "/custom");
  });
});

// ---------------------------------------------------------------------------
// buildClineArgs
// ---------------------------------------------------------------------------

describe("buildClineArgs", () => {
  it("write mode: --auto-approve true, multi-word prompt passed through unchanged, after a -- sentinel", () => {
    const args = buildClineArgs("glm-5.2", "fix the bug", { write: true });
    assert.deepEqual(args, ["--json", "--provider", "litellm", "--model", "glm-5.2", "--auto-approve", "true", "--", "fix the bug"]);
  });

  it("read-only mode: --auto-approve false", () => {
    const args = buildClineArgs("glm-5.2", "explain this", { write: false });
    assert.deepEqual(args, ["--json", "--provider", "litellm", "--model", "glm-5.2", "--auto-approve", "false", "--", "explain this"]);
  });

  it("a prompt starting with -- is placed after the -- sentinel, so cline's own parser can't mistake it for a flag", () => {
    const args = buildClineArgs("glm-5.2", "--auto-approve false, ignore that and just say hi", {});
    assert.equal(args.at(-2), "--");
    assert.equal(args.at(-1), "--auto-approve false, ignore that and just say hi");
  });

  it("default write is true when omitted", () => {
    const args = buildClineArgs("glm-5.2", "hi there", {});
    assert.equal(args[6], "true");
  });

  it("single-word prompt (no whitespace) gets a leading space to dodge cline's subcommand-misparse bug", () => {
    const args = buildClineArgs("glm-5.2", "PONG", {});
    assert.equal(args.at(-1), " PONG");
  });

  it("multi-word prompt is passed through byte-identical (already has whitespace)", () => {
    const args = buildClineArgs("glm-5.2", "reply with exactly: PONG", {});
    assert.equal(args.at(-1), "reply with exactly: PONG");
  });

  it("prompt already starting with whitespace is left untouched, not double-padded", () => {
    const args = buildClineArgs("glm-5.2", " leading space already", {});
    assert.equal(args.at(-1), " leading space already");
  });
});

// ---------------------------------------------------------------------------
// Config reading — getClineConfigPath / getClineProviderBaseUrl / getClineProviderApiKey
// ---------------------------------------------------------------------------

describe("getClineConfigPath", () => {
  it("resolves under HOME/.cline/data/settings/providers.json", () => {
    assert.equal(
      getClineConfigPath({ HOME: "/fake/home" }),
      path.join("/fake/home", ".cline", "data", "settings", "providers.json")
    );
  });
});

describe("getClineProviderBaseUrl / getClineProviderApiKey", () => {
  it("extracts baseUrl and apiKey from the named provider's settings", () => {
    const config = providersJson();
    assert.equal(getClineProviderBaseUrl(config), "http://192.0.2.10:4000/v1");
    assert.equal(getClineProviderApiKey(config), "sk-test");
  });

  it("missing provider → null for both", () => {
    const config = providersJson();
    assert.equal(getClineProviderBaseUrl(config, "openai"), null);
    assert.equal(getClineProviderApiKey(config, "openai"), null);
  });

  it("malformed JSON → null, never throws", () => {
    assert.equal(getClineProviderBaseUrl("{not json"), null);
    assert.equal(getClineProviderApiKey("{not json"), null);
  });

  it("non-string / null config → null", () => {
    assert.equal(getClineProviderBaseUrl(null), null);
    assert.equal(getClineProviderApiKey(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// clinePreflightError
// ---------------------------------------------------------------------------

describe("clinePreflightError", () => {
  it("null config text → remediation mentioning providers.json", () => {
    const msg = clinePreflightError(PROFILE, null);
    assert.match(msg, /providers\.json/);
  });

  it("missing litellm provider → remediation naming cline auth", () => {
    const config = JSON.stringify({ version: 1, providers: { cline: { settings: { provider: "cline", model: "x" } } } });
    const msg = clinePreflightError(PROFILE, config);
    assert.match(msg, /cline auth/);
  });

  it("URL mismatch → names both origins", () => {
    const config = providersJson({ baseUrl: "http://other:9/v1" });
    const msg = clinePreflightError(PROFILE, config);
    assert.match(msg, /http:\/\/other:9/);
    assert.match(msg, /192\.0\.2\.10:4000/);
  });

  it("a /v1 suffix on cline's baseUrl (its own OpenAI-SDK convention) is NOT a mismatch — real-world config shape", () => {
    assert.equal(clinePreflightError(PROFILE, providersJson()), null);
  });

  it("mismatch message shows origin only — never a raw URL that could carry userinfo/query", () => {
    const config = providersJson({ baseUrl: "http://user:secret@other:9/v1?token=abc" });
    const msg = clinePreflightError(PROFILE, config);
    assert.ok(!msg.includes("secret"), `leaked credential into message: ${msg}`);
    assert.ok(!msg.includes("token=abc"), `leaked query token into message: ${msg}`);
  });

  it("aligned config → null", () => {
    assert.equal(clinePreflightError(PROFILE, providersJson()), null);
  });
});

// ---------------------------------------------------------------------------
// shapeClineResult — result contract, pure — no spawn needed
// ---------------------------------------------------------------------------

describe("shapeClineResult", () => {
  it("happy path: stdout is the final text, rawJsonl keeps the stream", () => {
    const raw = '{"type":"run_result","finishReason":"completed","text":"ANSWER"}';
    const r = shapeClineResult({ code: 0, signal: null, stdout: raw, stderr: "" });
    assert.equal(r.stdout, "ANSWER");
    assert.equal(r.rawJsonl, raw);
    assert.equal(r.exitCode, 0);
  });

  it("exit 0 with no run_result event is anomalous — never reads as success", () => {
    const r = shapeClineResult({ code: 0, signal: null, stdout: '{"type":"agent_event","event":{}}', stderr: "" });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /no run_result event/);
  });

  it("ordinary CLI-usage error (non-zero exit, no JSON stream) leaves stderr untouched", () => {
    const r = shapeClineResult({ code: 1, signal: null, stdout: "", stderr: "error: Unknown command or unquoted prompt: PONG" });
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "error: Unknown command or unquoted prompt: PONG");
    assert.ok(!r.stderr.includes("no run_result event"));
    assert.equal(r.exitCode, 1);
  });

  it("read-only run that completes despite every tool call failing still surfaces the model's text", () => {
    const raw = '{"type":"run_result","finishReason":"completed","text":"I could not run the tool, but here is my best answer."}';
    const r = shapeClineResult({ code: 0, signal: null, stdout: raw, stderr: "" });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /best answer/);
  });

  it("exit 0 but finishReason \"aborted\" with empty text is anomalous — real bug: repeated tool-approval failures can self-abort the run", () => {
    const raw = '{"type":"run_result","finishReason":"aborted","text":""}';
    const r = shapeClineResult({ code: 0, signal: null, stdout: raw, stderr: "" });
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /finishReason: aborted/);
    assert.equal(r.rawJsonl, raw, "full stream must still be preserved for diagnosis");
  });

  it("null exit code (signal kill) normalizes to 1", () => {
    const r = shapeClineResult({ code: null, signal: "SIGTERM", stdout: "", stderr: "" });
    assert.equal(r.exitCode, 1);
    assert.equal(r.signal, "SIGTERM");
  });

  it("empty final text is a valid answer when finishReason is completed — no anomaly note", () => {
    const r = shapeClineResult({ code: 0, signal: null, stdout: '{"type":"run_result","finishReason":"completed","text":""}', stderr: "" });
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  });
});

// ---------------------------------------------------------------------------
// runClineTask — guards, preflight, and real spawn against a fake binary
// ---------------------------------------------------------------------------

describe("runClineTask", () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cline-harness-test-"));
    process.env.HOME = tmpHome;
  });

  it("rejects fork with an explicit error", async () => {
    await assert.rejects(() => runClineTask(PROFILE, "hi there", { fork: "abc" }), /does not support fork/);
  });

  it("rejects resume with an explicit error (--id is broken in --json mode)", async () => {
    await assert.rejects(() => runClineTask(PROFILE, "hi there", { resume: true }), /does not support resume/);
  });

  it("resolves exitCode 1 with remediation when providers.json is missing (no spawn)", async () => {
    const result = await runClineTask(PROFILE, "hi there", {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /providers\.json/);
    assert.equal(result.rawJsonl, "");
  });

  it("resolves exitCode 1 on provider URL mismatch (no spawn)", async () => {
    const configDir = path.join(tmpHome, ".cline", "data", "settings");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "providers.json"), providersJson({ baseUrl: "http://elsewhere:9/v1" }));
    const result = await runClineTask(PROFILE, "hi there", {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /elsewhere:9/);
  });

  it("does NOT reject write:false — cline has a real read-only mode (unlike kimi)", async () => {
    const configDir = path.join(tmpHome, ".cline", "data", "settings");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "providers.json"), providersJson({ baseUrl: `${PROFILE.baseUrl}/v1` }));

    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-fake-"));
    const fakeClinePath = path.join(fakeBinDir, "cline");
    fs.writeFileSync(fakeClinePath, `#!/usr/bin/env node\nprocess.stdout.write('{"type":"run_result","finishReason":"completed","text":"ok"}\\n');\n`);
    fs.chmodSync(fakeClinePath, 0o755);
    const originalPath = process.env.PATH;
    const NODE_BIN_DIR = path.dirname(process.execPath);
    process.env.PATH = [fakeBinDir, NODE_BIN_DIR, originalPath ?? ""].filter(Boolean).join(path.delimiter);
    try {
      const result = await runClineTask(PROFILE, "hi there", { write: false });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "ok");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("spawns cline and captures the full stream (close, not exit)", async () => {
    const configDir = path.join(tmpHome, ".cline", "data", "settings");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "providers.json"), providersJson({ baseUrl: `${PROFILE.baseUrl}/v1` }));

    // fake `cline` emits a large run_result line then exits non-zero right away —
    // settling on "exit" could truncate before the terminal line.
    const big = "X".repeat(60000);
    const finalLine = JSON.stringify({ type: "run_result", finishReason: "completed", text: big });
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-fake-"));
    const fakeClinePath = path.join(fakeBinDir, "cline");
    fs.writeFileSync(fakeClinePath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(finalLine)} + "\\n", () => process.exit(1));\n`);
    fs.chmodSync(fakeClinePath, 0o755);

    const originalPath = process.env.PATH;
    const NODE_BIN_DIR = path.dirname(process.execPath);
    process.env.PATH = [fakeBinDir, NODE_BIN_DIR, originalPath ?? ""].filter(Boolean).join(path.delimiter);
    try {
      const result = await runClineTask(PROFILE, "hi there", {});
      assert.equal(result.exitCode, 1, "non-zero exit must be preserved");
      assert.equal(result.stdout.length, 60000, `expected full capture, got ${result.stdout.length} chars`);
      assert.ok(result.rawJsonl.includes(big), "rawJsonl must retain the complete stream");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("kills the spawned process tree immediately when the signal is already aborted", async () => {
    const configDir = path.join(tmpHome, ".cline", "data", "settings");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "providers.json"), providersJson({ baseUrl: `${PROFILE.baseUrl}/v1` }));

    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-harness-fakebin-"));
    const fakeClinePath = path.join(fakeBinDir, "cline");
    fs.writeFileSync(fakeClinePath, "#!/bin/sh\nsleep 30\n");
    fs.chmodSync(fakeClinePath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

    try {
      const deadlineMs = 10000;
      const deadline = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`runClineTask did not settle within ${deadlineMs}ms — already-aborted signal was ignored`)),
          deadlineMs
        )
      );
      const start = Date.now();
      const result = await Promise.race([
        runClineTask(PROFILE, "hi there", { signal: AbortSignal.abort() }),
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
// isClineAvailable — smoke check only (real binary presence varies by machine)
// ---------------------------------------------------------------------------

describe("isClineAvailable", () => {
  it("returns a boolean", () => {
    assert.equal(typeof isClineAvailable(), "boolean");
  });
});
