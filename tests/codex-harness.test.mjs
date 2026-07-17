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
