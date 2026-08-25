import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCodexEnv,
  extractCodexFailure,
  runCodexTask,
  runTask,
  isCodexAvailable,
  parseCodexJsonl,
  shapeCodexResult,
  extractCodexThreadId,
} from "../plugins/gateway/scripts/lib/codex-harness.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");
const REPO_ROOT = path.join(__dirname, "..");
// The node bin dir must stay on PATH so the fake codex's `#!/usr/bin/env node`
// shebang resolves — an earlier test in this file overwrites process.env.PATH,
// so build PATH explicitly instead of trusting the ambient value.
const NODE_BIN_DIR = path.dirname(process.execPath);
function pathWithFakeBin(fakeDir) {
  return [fakeDir, NODE_BIN_DIR, savedEnv.PATH ?? ""].filter(Boolean).join(path.delimiter);
}

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

  it("passes XDG_ prefixed env vars", () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const savedXdgData = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_CONFIG_HOME = "/custom/config";
      process.env.XDG_DATA_HOME = "/custom/data";

      const env = buildCodexEnv(CODEX_PROFILE);

      assert.strictEqual(env.XDG_CONFIG_HOME, "/custom/config");
      assert.strictEqual(env.XDG_DATA_HOME, "/custom/data");
    } finally {
      if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
      else delete process.env.XDG_CONFIG_HOME;
      if (savedXdgData !== undefined) process.env.XDG_DATA_HOME = savedXdgData;
      else delete process.env.XDG_DATA_HOME;
    }
  });

  it("spreads non-auth subprocessEnv from profile", () => {
    const profile = {
      ...CODEX_PROFILE,
      subprocessEnv: {
        CUSTOM_VAR: "custom-value",
        MY_SETTING: "abc",
      },
    };
    const env = buildCodexEnv(profile);

    assert.strictEqual(env.CUSTOM_VAR, "custom-value");
    assert.strictEqual(env.MY_SETTING, "abc");
    // But auth keys still win
    assert.strictEqual(env.OPENAI_API_KEY, "test-api-key");
  });
});

// ---------------------------------------------------------------------------
// extractCodexFailure — pulls one clean line out of the codex --json stream
// ---------------------------------------------------------------------------

// codex reports failures as events on STDOUT. This mirrors a real fake-model
// run: a metadata warning item, then an `error` event, then the terminal
// `turn.failed` event — each carrying a nested JSON error body.
const NESTED_400 = JSON.stringify({
  error: {
    message: "/responses: Invalid model name passed in model=fake-model-xyz. Call `/v1/models` to view available models for your key.",
    code: "400",
    provider_specific_fields: { error: "leak-me-not" },
  },
});
const CODEX_FAILURE_STREAM = [
  JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
  JSON.stringify({ type: "item.completed", item: { id: "i0", type: "error", message: "Model metadata for `fake-model-xyz` not found. Defaulting to fallback metadata." } }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "error", message: NESTED_400 }),
  JSON.stringify({ type: "turn.failed", error: { message: NESTED_400 } }),
].join("\n") + "\n";

describe("extractCodexFailure", () => {
  it("extracts and unwraps the nested turn.failed error into one HTTP-tagged line", () => {
    const line = extractCodexFailure(CODEX_FAILURE_STREAM);
    assert.equal(
      line,
      "HTTP 400: /responses: Invalid model name passed in model=fake-model-xyz. Call `/v1/models` to view available models for your key.",
    );
    // The raw JSON envelope must never survive into the extracted line.
    assert.ok(!line.includes("turn.failed"), "extracted line must not carry the raw event type");
    assert.ok(!line.includes("provider_specific_fields"), "extracted line must not carry the raw JSON body");
    assert.ok(!line.includes("{"), "extracted line must be plain text, not JSON");
  });

  it("returns '' for a clean stream with no failure events", () => {
    const clean = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }),
    ].join("\n") + "\n";
    assert.equal(extractCodexFailure(clean), "");
  });

  it("returns '' for empty / non-string input", () => {
    assert.equal(extractCodexFailure(""), "");
    assert.equal(extractCodexFailure(undefined), "");
    assert.equal(extractCodexFailure(null), "");
  });

  it("prefers turn.failed over a standalone error event and an item error", () => {
    const stream = [
      JSON.stringify({ type: "item.completed", item: { type: "error", message: "metadata warning" } }),
      JSON.stringify({ type: "error", message: "boom-error-event" }),
      JSON.stringify({ type: "turn.failed", error: { message: "the real failure" } }),
    ].join("\n") + "\n";
    assert.equal(extractCodexFailure(stream), "the real failure");
  });

  it("falls back to an error event, then an item error, when turn.failed is absent", () => {
    const errStream = [
      JSON.stringify({ type: "item.completed", item: { type: "error", message: "metadata warning" } }),
      JSON.stringify({ type: "error", message: "boom-error-event" }),
    ].join("\n") + "\n";
    assert.equal(extractCodexFailure(errStream), "boom-error-event");

    const itemStream = JSON.stringify({ type: "item.completed", item: { type: "error", message: "only an item error" } }) + "\n";
    assert.equal(extractCodexFailure(itemStream), "only an item error");
  });

  it("handles a plain-string error message (no nested JSON, no code)", () => {
    const stream = JSON.stringify({ type: "turn.failed", error: { message: "plain failure text" } }) + "\n";
    assert.equal(extractCodexFailure(stream), "plain failure text");
  });

  it("ignores non-JSON and blank lines without throwing", () => {
    const noisy = [
      "not json at all",
      "",
      "   ",
      JSON.stringify({ type: "turn.failed", error: { message: "survivor" } }),
    ].join("\n");
    assert.equal(extractCodexFailure(noisy), "survivor");
  });
});

// ---------------------------------------------------------------------------
// Fake-codex harness: capture-completeness (the `close` race fix) and the
// end-to-end CLI failure contract (redacted message + 0600 log + exit 1, never
// empty). A tiny node script stands in for the real `codex` binary.
// ---------------------------------------------------------------------------

// Writes an executable fake `codex` onto a fresh dir and returns { dir, bin }.
// `mode`: "fail" emits the failure stream (stdout) + a giant catalog line
// (stderr) then exits 1; "bulk" emits a large deterministic stdout blob then
// exits 1 (to prove full capture on a fast-exiting child).
function writeFakeCodex(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fake-"));
  const bin = path.join(dir, "codex");
  const nestedForScript = JSON.stringify(NESTED_400);
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 0.0.0-fake\\n"); process.exit(0); }
// Drain stdin (the harness pipes the prompt in) before emitting.
let buf = "";
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  const MODE = ${JSON.stringify(mode)};
  if (MODE === "bulk") {
    // 60k of deterministic data emitted right before a fast non-zero exit.
    process.stdout.write("X".repeat(60000) + "\\n", () => process.exit(1));
    return;
  }
  if (MODE === "echo-args") {
    // Task 25/26: proves the actual argv runCodexTask builds, not just its
    // return value — e.g. that --ephemeral is gone, and resume uses an
    // explicit thread id + --json instead of --last.
    process.stdout.write(JSON.stringify(args) + "\\n", () => process.exit(0));
    return;
  }
  if (MODE === "auth") {
    // codex authenticated via a ChatGPT account rejects non-OpenAI models —
    // isCodexAuthError() matches on this exact substring.
    process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "Rejected: this ChatGPT account cannot use non-OpenAI models." } }) + "\\n", () => process.exit(1));
    return;
  }
  if (MODE === "success") {
    // A clean run: two agent_message items (proves last-one-wins) then a
    // proper turn.completed terminal event.
    const successLines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-2" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "intermediate remark" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "CODEX-SUCCESS-FINAL" } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\\n") + "\\n";
    process.stdout.write(successLines, () => process.exit(0));
    return;
  }
  if (MODE === "no-terminal") {
    // Process exits 0 but never emits turn.completed/turn.failed — must never
    // read as success (Task 16).
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t-3" }) + "\\n", () => process.exit(0));
    return;
  }
  const NESTED = ${nestedForScript};
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
    JSON.stringify({ type: "item.completed", item: { id: "i0", type: "error", message: "Model metadata for fake-model-xyz not found." } }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "error", message: NESTED }),
    JSON.stringify({ type: "turn.failed", error: { message: NESTED } }),
  ].join("\\n") + "\\n";
  // A giant single-line backend catalog on stderr, plus a Bearer token, to
  // prove neither reaches the agent-visible stdout surface.
  const catalog = "ERROR codex_models_manager: body:" + JSON.stringify({ data: Array.from({ length: 40 }, (_, i) => ({ id: "model-" + i })) }) + " Authorization: Bearer sk-secret-should-never-surface";
  process.stderr.write(catalog + "\\n" + catalog + "\\n");
  process.stdout.write(lines, () => process.exit(1));
});
`;
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return { dir, bin };
}

describe("runCodexTask — capture completeness (resolves on close, not exit)", () => {
  it("captures the child's full stdout even when it exits immediately after a large write", async () => {
    const { dir } = writeFakeCodex("bulk");
    const originalPath = process.env.PATH;
    process.env.PATH = pathWithFakeBin(dir);
    try {
      const profile = { name: "fake", kind: "claude-gateway", baseUrl: "http://127.0.0.1:1", defaultModel: "m", apiKey: "k" };
      const result = await runCodexTask(profile, "hi", { model: "m", write: false });
      assert.equal(result.exitCode, 1, "non-zero exit must be preserved");
      // Resolving on "exit" instead of "close" could truncate this; "close"
      // guarantees the full 60000-char payload was drained before settling.
      assert.equal(result.stdout.trim().length, 60000, `expected full capture, got ${result.stdout.trim().length} chars`);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ---------------------------------------------------------------------------
// Task 25/26 — real args runCodexTask builds: no --ephemeral on a normal run
// (Task 25 root cause: it silently blocked all persistence, so resume always
// attached to nothing), and resume requires an explicit thread id + --json
// (never --last, which Task 25 proved is not attributable to a specific job
// under concurrency).
// ---------------------------------------------------------------------------

describe("runCodexTask — args (Task 25/26)", () => {
  it("normal run never passes --ephemeral (must persist so a later resume can attach)", async () => {
    const { dir } = writeFakeCodex("echo-args");
    const originalPath = process.env.PATH;
    process.env.PATH = pathWithFakeBin(dir);
    try {
      const profile = { name: "fake", kind: "claude-gateway", baseUrl: "http://127.0.0.1:1", defaultModel: "m", apiKey: "k" };
      const result = await runCodexTask(profile, "hi", { model: "m", write: false });
      const args = JSON.parse(result.stdout.trim());
      assert.ok(!args.includes("--ephemeral"), `expected no --ephemeral, got: ${JSON.stringify(args)}`);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("resume with an explicit resumeRef: exec resume <id> --json, never --last -- still routes through the gateway provider via -m/-c (cross-review finding, verified live)", async () => {
    const { dir } = writeFakeCodex("echo-args");
    const originalPath = process.env.PATH;
    process.env.PATH = pathWithFakeBin(dir);
    try {
      const profile = { name: "fake", kind: "claude-gateway", baseUrl: "http://127.0.0.1:1", defaultModel: "m", apiKey: "k" };
      const result = await runCodexTask(profile, "hi", { resume: true, resumeRef: "01a0392f-thread-id" });
      const args = JSON.parse(result.stdout.trim());
      assert.deepEqual(args, [
        "exec", "resume", "01a0392f-thread-id", "--json", "-m", "m",
        "-c", 'model_provider="gateway"',
        "-c", 'model_providers.gateway.name="Gateway"',
        "-c", 'model_providers.gateway.base_url="http://127.0.0.1:1"',
        "-c", 'model_providers.gateway.env_key="OPENAI_API_KEY"',
        "-c", 'model_providers.gateway.wire_api="responses"',
      ]);
      assert.ok(!args.includes("-s"), "resume does not accept -s (absent from `codex exec resume --help`)");
      assert.ok(!args.includes("-C"), "resume does not accept -C (absent from `codex exec resume --help`)");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  // Cross-review + LIVE verification: a `-c sandbox_mode="read-only"`
  // override was tried and confirmed to have NO effect on a resumed turn (it
  // still wrote a file to disk, exit 0, no sandbox-denial anywhere in the
  // stream) -- so runCodexTask deliberately does NOT attempt it; opts.write
  // is silently a no-op for the resume branch's args, by design. The actual
  // safety enforcement lives in gateway-companion.mjs (handleTask refuses to
  // resume codex with an effective write:false at all).
  it("resume args never include sandbox_mode -- opts.write has no effect on resume argv (verified ineffective, see codex-harness.mjs comment)", async () => {
    const { dir } = writeFakeCodex("echo-args");
    const originalPath = process.env.PATH;
    process.env.PATH = pathWithFakeBin(dir);
    try {
      const profile = { name: "fake", kind: "claude-gateway", baseUrl: "http://127.0.0.1:1", defaultModel: "m", apiKey: "k" };
      const resultWrite = await runCodexTask(profile, "hi", { resume: true, resumeRef: "id", write: true });
      const resultNoWrite = await runCodexTask(profile, "hi", { resume: true, resumeRef: "id", write: false });
      assert.deepEqual(JSON.parse(resultWrite.stdout.trim()), JSON.parse(resultNoWrite.stdout.trim()));
      assert.ok(!JSON.parse(resultWrite.stdout.trim()).some((a) => String(a).includes("sandbox_mode")));
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("resume without a resumeRef throws synchronously (no spawn, no silent --last fallback)", () => {
    const profile = { name: "fake", kind: "claude-gateway", baseUrl: "http://127.0.0.1:1", defaultModel: "m", apiKey: "k" };
    assert.throws(() => runCodexTask(profile, "hi", { resume: true }), /resumeRef/);
  });
});

// ---------------------------------------------------------------------------
// Task 14 — runTask must fail loud on both codex-unavailable and codex
// auth-error paths, never silently fall back to the claude harness.
// ---------------------------------------------------------------------------

describe("runTask — no silent fallback to claude (Task 14)", () => {
  it("codex CLI missing: fails with remediation, never tries claude", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-missing-"));
    const originalPath = process.env.PATH;
    process.env.PATH = emptyDir; // no codex, no claude, nothing resolvable
    try {
      assert.equal(await isCodexAvailable(), false, "sanity: codex must be unresolvable on this PATH");
      const result = await runTask(CODEX_PROFILE, "hi", { harness: "codex", model: "m", write: false });
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /--harness codex requires codex CLI/);
      assert.match(result.stderr, /npm i -g @openai\/codex/);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("codex auth error (ChatGPT account): fails with remediation, never tries claude", async () => {
    const { dir } = writeFakeCodex("auth");
    const originalPath = process.env.PATH;
    process.env.PATH = pathWithFakeBin(dir);
    try {
      const result = await runTask(CODEX_PROFILE, "hi", { harness: "codex", model: "m", write: false });
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /ChatGPT account/);
      // Never the old silent-fallback text, and never an attempt to spawn claude.
      assert.ok(!result.stderr.includes("claude fallback"), `unexpected leftover fallback wording: ${result.stderr}`);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ---------------------------------------------------------------------------
// Task 15/16 — output normalization (parity with zero/kimi/cline) and
// fail-loud on absence of a terminal event.
// ---------------------------------------------------------------------------

function jsonl(...events) {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("parseCodexJsonl", () => {
  it("clean success: hasFinal + hasTerminal, finalText from the agent_message", () => {
    const raw = jsonl(
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "the answer" } },
      { type: "turn.completed" },
    );
    const parsed = parseCodexJsonl(raw);
    assert.equal(parsed.hasFinal, true);
    assert.equal(parsed.hasTerminal, true);
    assert.equal(parsed.finalText, "the answer");
  });

  it("several agent_message items: the LAST one wins", () => {
    const raw = jsonl(
      { type: "item.completed", item: { type: "agent_message", text: "first" } },
      { type: "item.completed", item: { type: "agent_message", text: "second" } },
      { type: "item.completed", item: { type: "agent_message", text: "final one" } },
      { type: "turn.completed" },
    );
    assert.equal(parseCodexJsonl(raw).finalText, "final one");
  });

  it("empty final text is a valid answer when a proper terminal event closes the turn", () => {
    const raw = jsonl(
      { type: "item.completed", item: { type: "agent_message", text: "" } },
      { type: "turn.completed" },
    );
    const parsed = parseCodexJsonl(raw);
    assert.equal(parsed.hasFinal, true);
    assert.equal(parsed.hasTerminal, true);
    assert.equal(parsed.finalText, "");
  });

  it("turn.failed alone: hasTerminal true, hasFinal false (no agent_message)", () => {
    const raw = jsonl({ type: "turn.failed", error: { message: "boom" } });
    const parsed = parseCodexJsonl(raw);
    assert.equal(parsed.hasTerminal, true);
    assert.equal(parsed.hasFinal, false);
    assert.equal(parsed.finalText, null);
  });

  it("no turn.completed/turn.failed/error anywhere: hasTerminal false", () => {
    const raw = jsonl(
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { type: "agent_message", text: "stray text" } },
    );
    // Note: an agent_message CAN appear without the turn ever closing —
    // hasFinal is true, but hasTerminal must still be false.
    const parsed = parseCodexJsonl(raw);
    assert.equal(parsed.hasFinal, true);
    assert.equal(parsed.hasTerminal, false);
  });

  it("empty/garbage input: no events, hasTerminal false, hasFinal false", () => {
    assert.deepStrictEqual(parseCodexJsonl(""), { finalText: null, hasFinal: false, hasTerminal: false });
    assert.deepStrictEqual(parseCodexJsonl("not json\n{{{\n"), { finalText: null, hasFinal: false, hasTerminal: false });
  });
});

// ---------------------------------------------------------------------------
// extractCodexThreadId (Task 25/26 continuation reference)
// ---------------------------------------------------------------------------

describe("extractCodexThreadId", () => {
  it("extracts thread_id from the thread.started event", () => {
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "01a0392f-23f3-7212-a164-043fda04d864" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    assert.equal(extractCodexThreadId(raw), "01a0392f-23f3-7212-a164-043fda04d864");
  });

  it("no thread.started event → null", () => {
    const raw = JSON.stringify({ type: "turn.completed" });
    assert.equal(extractCodexThreadId(raw), null);
  });

  it("skips corrupt lines and empty input without throwing", () => {
    assert.equal(extractCodexThreadId("not json\n{broken"), null);
    assert.equal(extractCodexThreadId(""), null);
    assert.equal(extractCodexThreadId(null), null);
  });
});

describe("shapeCodexResult", () => {
  it("success: stdout is the final message, rawJsonl keeps the full stream, exitCode preserved", () => {
    const raw = jsonl(
      { type: "item.completed", item: { type: "agent_message", text: "OK done" } },
      { type: "turn.completed" },
    );
    const shaped = shapeCodexResult({ stdout: raw, stderr: "", exitCode: 0, signal: null });
    assert.equal(shaped.stdout, "OK done");
    assert.equal(shaped.exitCode, 0);
    assert.equal(shaped.rawJsonl, raw);
  });

  it("no terminal event: forced to exitCode 1 regardless of the raw exit code", () => {
    const raw = jsonl({ type: "thread.started", thread_id: "t" });
    const shaped = shapeCodexResult({ stdout: raw, stderr: "", exitCode: 0, signal: null });
    assert.equal(shaped.stdout, "");
    assert.equal(shaped.exitCode, 1, "exit 0 with no terminal event must never read as success");
    assert.match(shaped.stderr, /no terminal event/);
    assert.equal(shaped.rawJsonl, raw, "raw stream must still be preserved for the log even on this failure");
  });

  it("turn.failed with no agent_message: empty stdout, real exit code preserved, rawJsonl kept", () => {
    const raw = jsonl({ type: "turn.failed", error: { message: "quota exceeded" } });
    const shaped = shapeCodexResult({ stdout: raw, stderr: "some catalog dump", exitCode: 1, signal: null });
    assert.equal(shaped.stdout, "");
    assert.equal(shaped.exitCode, 1);
    assert.equal(shaped.rawJsonl, raw);
  });

  it("never leaks the raw JSONL stream into stdout on the success path", () => {
    const raw = jsonl(
      { type: "item.completed", item: { type: "agent_message", text: "clean" } },
      { type: "turn.completed" },
    );
    const shaped = shapeCodexResult({ stdout: raw, stderr: "", exitCode: 0, signal: null });
    assert.ok(!shaped.stdout.includes('"type"'), `stdout must not carry raw JSONL: ${shaped.stdout}`);
  });
});

describe("CLI task --harness codex failure contract (fake codex, 5 runs)", () => {
  it("every run: non-empty complete stdout, redacted message, 0600 log, exit 1, no raw JSON/catalog leak", async () => {
    const { dir } = writeFakeCodex("fail");
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-cfg-"));
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        // A realistic multi-char secret: single-letter secrets would collide
        // with ordinary letters in the message and get spuriously redacted.
        profiles: { fake: { kind: "claude-gateway", baseUrl: "http://127.0.0.1:1", defaultModel: "m", apiKey: "gw-config-secret-abc123" } },
        defaultProfile: "fake", reviewProfile: "fake", taskProfile: "fake",
      }),
    );
    const env = {
      ...process.env,
      PATH: pathWithFakeBin(dir),
      GATEWAY_PLUGIN_CONFIG_DIR: configDir,
    };

    for (let i = 1; i <= 5; i++) {
      let stdout = "";
      let code = 0;
      try {
        const r = await execFileAsync(
          process.execPath,
          [COMPANION, "task", "--harness", "codex", "--no-write", "--profile", "fake", "--model", "fake-model-xyz", "reply OK"],
          { cwd: REPO_ROOT, env, timeout: 30_000 },
        );
        stdout = r.stdout;
      } catch (err) {
        stdout = err.stdout ?? "";
        code = typeof err.code === "number" ? err.code : 1;
      }

      const tag = `run ${i}`;
      // The race guard: stdout must never be empty on failure.
      assert.ok(stdout.trim().length > 0, `${tag}: agent-visible stdout was empty (parent-exit race)`);
      assert.equal(code, 1, `${tag}: expected exit 1`);
      // Fail-loud: the extracted, redacted message is present.
      assert.match(stdout, /Invalid model name passed in model=fake-model-xyz/, `${tag}: missing actionable message`);
      assert.match(stdout, /Full details:\s*\S+\.log/, `${tag}: missing 0600 log pointer`);
      // Leak-safe: no raw codex JSON stream / backend catalog / secret on stdout.
      assert.ok(!stdout.includes("turn.failed"), `${tag}: raw turn.failed JSON leaked to agent stdout`);
      assert.ok(!stdout.includes("thread.started"), `${tag}: raw JSON stream leaked to agent stdout`);
      assert.ok(!/"data":\s*\[/.test(stdout), `${tag}: backend catalog leaked to agent stdout`);
      assert.ok(!stdout.includes("Bearer "), `${tag}: Bearer token leaked to agent stdout`);
      assert.ok(!stdout.includes("sk-secret"), `${tag}: secret leaked to agent stdout`);

      // The 0600 log holds the complete raw material, unredacted, mode 600.
      const logPath = stdout.match(/Full details:\s*(\S+\.log)/)?.[1];
      assert.ok(logPath && fs.existsSync(logPath), `${tag}: log file not written`);
      assert.equal(fs.statSync(logPath).mode & 0o777, 0o600, `${tag}: log must be mode 0600`);
      const logBody = fs.readFileSync(logPath, "utf8");
      assert.ok(logBody.includes("turn.failed"), `${tag}: log must retain the raw turn.failed JSON`);
      assert.ok(/"data":\s*\[/.test(logBody), `${tag}: log must retain the full stderr catalog`);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 15/16 — end-to-end through the real CLI: a clean success renders just
// the final message (never raw JSONL), and a stream with no terminal event
// fails loud even though the process itself exited 0.
// ---------------------------------------------------------------------------

function writeFakeCliConfig() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-cfg-"));
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      profiles: { fake: { kind: "claude-gateway", baseUrl: "http://127.0.0.1:1", defaultModel: "m", apiKey: "gw-config-secret-abc123" } },
      defaultProfile: "fake", reviewProfile: "fake", taskProfile: "fake",
    }),
  );
  return configDir;
}

describe("CLI task --harness codex output normalization (Task 15/16)", () => {
  it("clean success: CLI stdout is just the final message, never the raw JSONL stream", async () => {
    const { dir } = writeFakeCodex("success");
    const configDir = writeFakeCliConfig();
    const env = { ...process.env, PATH: pathWithFakeBin(dir), GATEWAY_PLUGIN_CONFIG_DIR: configDir };

    const { stdout } = await execFileAsync(
      process.execPath,
      [COMPANION, "task", "--harness", "codex", "--no-write", "--profile", "fake", "--model", "fake-model-xyz", "reply OK"],
      { cwd: REPO_ROOT, env, timeout: 30_000 },
    );

    assert.match(stdout, /CODEX-SUCCESS-FINAL/, "final agent_message text must reach stdout");
    // last-one-wins: only the LAST agent_message should surface, not the earlier one.
    assert.ok(!stdout.includes("intermediate remark"), "must not surface an earlier agent_message, only the last one");
    assert.ok(!stdout.includes('"type":"turn.completed"'), "raw JSONL must not leak to stdout");
    assert.ok(!stdout.includes('"type":"thread.started"'), "raw JSONL must not leak to stdout");
  });

  it("no terminal event: fails loud even though the fake process exited 0", async () => {
    const { dir } = writeFakeCodex("no-terminal");
    const configDir = writeFakeCliConfig();
    const env = { ...process.env, PATH: pathWithFakeBin(dir), GATEWAY_PLUGIN_CONFIG_DIR: configDir };

    let stdout = "";
    let code = 0;
    try {
      const r = await execFileAsync(
        process.execPath,
        [COMPANION, "task", "--harness", "codex", "--no-write", "--profile", "fake", "--model", "fake-model-xyz", "reply OK"],
        { cwd: REPO_ROOT, env, timeout: 30_000 },
      );
      stdout = r.stdout;
    } catch (err) {
      stdout = err.stdout ?? "";
      code = typeof err.code === "number" ? err.code : 1;
    }

    assert.notEqual(code, 0, "a stream with no terminal event must never report success, regardless of the raw exit code");
    assert.ok(stdout.length > 0, "must still report SOMETHING to the agent, not a silent empty success");
  });
});
