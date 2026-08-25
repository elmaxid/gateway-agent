// Codex harness — alternative to claude subprocess for stateful tasks.
// Uses OPENAI_BASE_URL/OPENAI_API_KEY (not ANTHROPIC_*).
// Fail-loud by design: no silent fallback to claude, on either the CLI-missing
// or the codex-auth-error path — runTask() returns a remediation message and
// a non-zero exit instead (parity with dispatch's own codex preflight).
import { spawn, execSync } from "node:child_process";
import process from "node:process";
import { pickEnv, sanitizeSubprocessEnv, terminateProcessTree } from "./subprocess-utils.mjs";

export function buildCodexEnv(profile) {
  const env = pickEnv(process.env);
  if (profile.subprocessEnv) {
    Object.assign(env, sanitizeSubprocessEnv(profile.subprocessEnv));
  }
  env.OPENAI_BASE_URL = profile.baseUrl;
  env.OPENAI_API_KEY = profile.apiKey || profile.authToken || "";
  return env;
}

export async function isCodexAvailable() {
  try {
    execSync("codex --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function runCodexTask(profile, prompt, opts = {}) {
  const model = opts.model || profile.defaultModel;
  const sandbox = opts.write === false ? "read-only" : "workspace-write";

  let args;
  if (opts.resume) {
    // Task 25/26: an explicit thread_id is the only reliable identifier —
    // `--last` picks "most recent in this cwd", which is not attributable to
    // a specific job under concurrency (verified empirically, see
    // docs/superpowers/plans/2026-08-25-task25-session-identity-investigation.md).
    if (!opts.resumeRef) {
      throw new Error("codex resume requires opts.resumeRef (a thread id captured from a prior turn)");
    }
    // -m/-c are valid options on `exec resume` (per `codex exec resume --help`)
    // and are passed for the same reason as the fresh-turn branch below:
    // route through the gateway profile rather than codex's own config.toml
    // default provider. -s/-C are NOT flags `resume` accepts (absent from its
    // --help) — AND resume does NOT inherit the source session's sandbox mode
    // either (verified against a real rollout log: a read-only turn 1 resumed
    // as workspace-write with no -s given). A `-c sandbox_mode=...` override
    // was tried here and verified LIVE to have NO effect either (a resumed
    // turn with write:false, override included, still wrote a file to disk
    // successfully, exit 0, no sandbox-denial event anywhere in the stream) —
    // codex resume cannot currently be forced read-only by any known means on
    // this codex version. The caller (gateway-companion.mjs handleTask) must
    // refuse to resume with write:false for codex rather than silently
    // mislabeling a write-capable run as read-only.
    args = [
      "exec", "resume", opts.resumeRef, "--json", "-m", model,
      "-c", 'model_provider="gateway"',
      "-c", 'model_providers.gateway.name="Gateway"',
      "-c", `model_providers.gateway.base_url="${profile.baseUrl}"`,
      "-c", 'model_providers.gateway.env_key="OPENAI_API_KEY"',
      "-c", 'model_providers.gateway.wire_api="responses"',
    ];
  } else {
    args = [
      // No --ephemeral: the session must persist to disk so a later turn can
      // resume it by thread_id (Task 25 root cause — --ephemeral silently
      // made every resume attempt find nothing real to attach to).
      "exec", "--json", "-m", model, "-s", sandbox,
      // Route to the gateway instead of the ChatGPT OAuth provider.
      // wire_api="responses" is required since codex 0.136.x dropped "chat".
      "-c", 'model_provider="gateway"',
      "-c", 'model_providers.gateway.name="Gateway"',
      "-c", `model_providers.gateway.base_url="${profile.baseUrl}"`,
      "-c", 'model_providers.gateway.env_key="OPENAI_API_KEY"',
      "-c", 'model_providers.gateway.wire_api="responses"',
    ];
    if (opts.cwd) args.push("-C", opts.cwd);
    if (opts.outputSchema) args.push("--output-schema", opts.outputSchema);
  }

  const env = buildCodexEnv(profile);
  const proc = spawn("codex", args, {
    cwd: opts.cwd || process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true
  });

  let stdout = "";
  let stderr = "";
  let stdoutBuf = "";

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");

  proc.stdout.on("data", (chunk) => {
    stdout += chunk;
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (opts.onStdout) opts.onStdout(line);
    }
  });

  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (opts.onStderr) opts.onStderr(chunk);
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  if (opts.signal) {
    const onAbort = () => terminateProcessTree(proc.pid); // always blocks 2s (SIGTERM grace period) before SIGKILL if process survives
    opts.signal.addEventListener("abort", onAbort, { once: true });
    proc.on("exit", () => opts.signal.removeEventListener("abort", onAbort));
  }

  return new Promise((resolve, reject) => {
    let exitCode = null;
    let exitSignal = null;
    proc.on("error", reject);
    // Record the exit status when the process ends...
    proc.on("exit", (code, sig) => { exitCode = code; exitSignal = sig; });
    // ...but only SETTLE on "close", which fires after the child's stdout AND
    // stderr streams have fully drained (EOF). Resolving on "exit" can settle
    // the run while buffered pipe data is still unread, so the captured output —
    // and everything the CLI derives from it, including the final result the
    // parent flushes as it exits — could be empty or partial depending on
    // scheduling. That was the intermittent "exit=1 with empty streams" race on
    // the codex failure path. "close" guarantees stdout/stderr are complete
    // before we shape and return the result.
    proc.on("close", (code, sig) => {
      if (stdoutBuf && opts.onStdout) { opts.onStdout(stdoutBuf); stdoutBuf = ""; }
      resolve({ stdout, stderr, exitCode: exitCode ?? code, signal: exitSignal ?? sig });
    });
  });
}

// Codex rejects non-OpenAI models when authenticated via ChatGPT account.
function isCodexAuthError(result) {
  const text = result.stdout + result.stderr;
  return result.exitCode !== 0 && text.includes("ChatGPT account");
}

// ---------------------------------------------------------------------------
// Failure extraction
//
// codex reports a task failure as a `turn.failed` / `error` event inside its
// --json stream on STDOUT (not stderr). Its STDERR on failure is the backend
// model-catalog dump. The CLI must surface a single, redacted, human-readable
// line — never the raw JSON stream or the catalog — so pull one clean line out
// of the stream here.
// ---------------------------------------------------------------------------

// A codex error message is frequently a nested JSON body, e.g.
//   {"error":{"message":"...","code":"400", ...}}
// Unwrap it to the inner message + status code when present.
function tryParseNestedError(message) {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const err = parsed && typeof parsed === "object" ? (parsed.error ?? parsed) : null;
    if (err && typeof err === "object") {
      return { message: err.message, code: err.code };
    }
  } catch {
    /* not nested JSON — use the string as-is */
  }
  return null;
}

function normalizeCodexError(err) {
  let message = "";
  let code;
  if (typeof err === "string") {
    message = err;
  } else if (err && typeof err === "object") {
    message = typeof err.message === "string" ? err.message : String(err.message ?? "");
    code = err.code;
  }
  const nested = tryParseNestedError(message);
  if (nested) {
    if (nested.message) message = String(nested.message);
    if (nested.code != null) code = nested.code;
  }
  message = message.trim();
  if (!message) return "";
  return code != null && String(code).length > 0 ? `HTTP ${code}: ${message}` : message;
}

/**
 * Extract a single human-readable failure line from a codex --json stdout
 * stream. Prefers the terminal `turn.failed` event, then a standalone `error`
 * event, then an `item.completed` error item. Returns "" when the stream shows
 * no failure signal (e.g. a clean run). Pure/synchronous — safe to unit test.
 * @param {string} stdout raw codex --json stream
 * @returns {string}
 */
export function extractCodexFailure(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) return "";
  let turnFailed = "";
  let errorEvent = "";
  let itemError = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!evt || typeof evt !== "object") continue;
    if (evt.type === "turn.failed" && evt.error != null) {
      turnFailed = normalizeCodexError(evt.error) || turnFailed;
    } else if (evt.type === "error" && (evt.error != null || evt.message != null)) {
      errorEvent = errorEvent || normalizeCodexError(evt.error ?? evt.message);
    } else if (evt.type === "item.completed" && evt.item && evt.item.type === "error" && evt.item.message) {
      itemError = itemError || String(evt.item.message).trim();
    }
  }
  return turnFailed || errorEvent || itemError || "";
}

// ---------------------------------------------------------------------------
// Output normalization (parity with zero/kimi/cline): a successful run's
// stdout becomes just the model's final message, never the raw --json event
// stream. The raw stream is preserved separately via `rawJsonl` — callers
// that want it for a log (shapeTaskFailure's codex branch, dispatch's job
// log) read that field, never `stdout`.
// ---------------------------------------------------------------------------

/**
 * Parse a codex --json stdout stream into the pieces shapeCodexResult needs.
 * Pure/synchronous — safe to unit test.
 * @param {string} raw
 */
export function parseCodexJsonl(raw) {
  const events = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt && typeof evt === "object" && typeof evt.type === "string") events.push(evt);
    } catch {
      // partial or corrupt line (e.g. process killed mid-write) — skip, never throw
    }
  }
  const agentMessages = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message");
  // Terminal = codex signaled the turn is over, one way or another. Covers
  // both the success shape (turn.completed) and the shapes extractCodexFailure
  // already knows how to read (turn.failed / error / item.completed error).
  const hasTerminal = events.some((e) =>
    e.type === "turn.completed" ||
    e.type === "turn.failed" ||
    e.type === "error" ||
    (e.type === "item.completed" && e.item?.type === "error")
  );
  return {
    // Several agent_message items can appear in one turn — last one wins
    // (same convention as zero's `finals.at(-1)`).
    finalText: agentMessages.length > 0 ? String(agentMessages.at(-1).item.text ?? "") : null,
    hasFinal: agentMessages.length > 0,
    hasTerminal
  };
}

/**
 * Extract the codex thread id (Task 25/26 continuation reference) from a raw
 * --json stdout stream. Emitted once per turn as the first event
 * (`{"type":"thread.started","thread_id":"..."}`), on both fresh and resumed
 * turns. Pure/synchronous — safe to unit test. Returns null when absent.
 * @param {string} raw
 * @returns {string|null}
 */
export function extractCodexThreadId(raw) {
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt && evt.type === "thread.started" && typeof evt.thread_id === "string" && evt.thread_id) {
        return evt.thread_id;
      }
    } catch {
      // partial or corrupt line — skip, never throw
    }
  }
  return null;
}

/**
 * Shape a raw runCodexTask() result into the normalized contract: stdout is
 * the final message (or "" when there is none to give), rawJsonl is always
 * the untouched raw stream, exitCode is forced to 1 when the stream shows no
 * terminal event at all — regardless of the raw exit code — because that is
 * never a success, matching the exact contract Task 16 asks for. An
 * agent_message with empty text is still a valid answer as long as a proper
 * terminal event closed the turn; that case is left alone.
 */
export function shapeCodexResult({ stdout, stderr, exitCode, signal }) {
  const parsed = parseCodexJsonl(stdout);

  if (!parsed.hasTerminal) {
    const note = "codex exec produced no terminal event (turn.completed/turn.failed) — raw JSONL preserved in rawJsonl/task log";
    return {
      stdout: "",
      stderr: stderr ? `${stderr}\n${note}` : note,
      exitCode: 1,
      signal: signal ?? null,
      rawJsonl: stdout
    };
  }

  return {
    stdout: parsed.hasFinal ? parsed.finalText : "",
    stderr: stderr ?? "",
    exitCode: exitCode ?? 1,
    signal: signal ?? null,
    rawJsonl: stdout
  };
}

export async function runTask(profile, prompt, opts = {}) {
  if (opts.harness === "codex") {
    if (!await isCodexAvailable()) {
      return {
        stdout: "",
        stderr: "--harness codex requires codex CLI. Install: npm i -g @openai/codex",
        exitCode: 1
      };
    }
    const result = await runCodexTask(profile, prompt, opts);
    if (isCodexAuthError(result)) {
      return {
        stdout: "",
        stderr: "codex rejected the request: it is authenticated via a ChatGPT account, which only " +
          "allows OpenAI models and cannot reach this profile's gateway model. Re-authenticate codex " +
          "against an API key instead of a ChatGPT account.",
        exitCode: result.exitCode ?? 1
      };
    }
    return shapeCodexResult(result);
  }
  const { runClaudeTask } = await import("./claude-subprocess.mjs");
  return runClaudeTask(profile, prompt, opts);
}
