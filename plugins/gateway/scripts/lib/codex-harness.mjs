// Codex harness — alternative to claude subprocess for stateful tasks.
// Uses OPENAI_BASE_URL/OPENAI_API_KEY (not ANTHROPIC_*).
// Falls back to claude subprocess if codex CLI not installed.
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

  let args;
  if (opts.resume) {
    args = ["exec", "resume", "--last"];
  } else {
    const sandbox = opts.write === false ? "read-only" : "workspace-write";
    args = [
      "exec", "--json", "--ephemeral", "-m", model, "-s", sandbox,
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

export async function runTask(profile, prompt, opts = {}) {
  if (opts.harness === "codex" && await isCodexAvailable()) {
    const result = await runCodexTask(profile, prompt, opts);
    if (!isCodexAuthError(result)) return result;
    // Fall through to claude subprocess only when the profile supports it
    if (profile.kind !== "claude-gateway") {
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
    }
  }
  if (profile.kind !== "claude-gateway") {
    return {
      stdout: "",
      stderr: `Profile "${profile.name}" has kind "${profile.kind}" — codex harness unavailable and claude fallback requires "claude-gateway". Install codex or use a claude-gateway profile.`,
      exitCode: 1
    };
  }
  const { runClaudeTask } = await import("./claude-subprocess.mjs");
  return runClaudeTask(profile, prompt, opts);
}
