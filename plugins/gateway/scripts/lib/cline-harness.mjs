// Cline harness — one-shot task delegation via the Cline CLI
// (cline.bot). Structurally mirrors kimi-harness.mjs, with deliberate
// differences:
//  - cline's provider/model config lives in a global
//    ~/.cline/data/settings/providers.json (JSON, not TOML) that ALSO
//    carries the api key inline — nothing is injected via env at spawn
//    time, unlike codex/claude/zero.
//  - the gateway plugin assumes cline's built-in "litellm" provider type
//    (an OpenAI-compatible custom-endpoint provider cline itself defines —
//    unlike kimi's "gateway" alias, this name is NOT ours to choose).
//  - unlike kimi, cline HAS a genuine read-only mode: `--auto-approve
//    false` makes every tool call fail with a clean "requires an
//    interactive session" error instead of executing, and the process
//    still exits 0 with a normal completed answer — write:false is fully
//    supported here, not rejected. CAVEAT (verified live, reproduced 3/3
//    runs): a read-only prompt that explicitly demands tool use can drive
//    the model into enough blocked-tool retries that cline self-aborts
//    the whole run (finishReason "aborted", empty text, exit 0 — looks
//    like a clean empty success unless finishReason is checked, see
//    parseClineStream below). Read-only prompts that don't require tools
//    (review/analysis/Q&A — the intended --no-write use case) are fine.
//  - unlike kimi, `--id` (session resume) does not work in this CLI
//    version when combined with `--json` + a prompt (verified: fails
//    identically whether the id comes from the JSON stream's taskId or
//    from `cline history --json`'s sessionId, via argv or stdin, in any
//    flag order) — resume is rejected, same as zero.
//  - cline's Commander parser misreads a single-word prompt with no
//    whitespace as an attempted (unknown) subcommand instead of prompt
//    text (verified: `cline ... "PONG"` errors "Unknown command or
//    unquoted prompt: PONG"; `cline ... " PONG"` — one leading space —
//    works correctly and does not change the model's answer). Prompts
//    with no whitespace get a leading space prepended before argv.
//  - stdout carries the extracted final answer text; the full JSON-line
//    stream is returned separately as rawJsonl (same field name dispatch.mjs
//    already looks for from zero-harness.mjs).
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pickEnv, sanitizeSubprocessEnv, terminateProcessTree, sameOriginAllowingV1, originOnly } from "./subprocess-utils.mjs";

export const CLINE_PROVIDER = "litellm";
const CLINE_SETUP_HINT = "Configure it manually via `cline auth --provider litellm --baseurl <url> --apikey <key> --modelid <model>` — see README.md (Cline harness setup).";

// Sync on purpose (execSync makes it sync anyway) — matches isZeroAvailable()/isKimiAvailable().
export function isClineAvailable() {
  try {
    execSync("cline --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function getClineConfigPath(env = process.env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".cline", "data", "settings", "providers.json");
}

export function readClineConfig(configPath) {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
}

function parseProvidersJson(configText, providerName) {
  if (typeof configText !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return null;
  }
  const settings = parsed?.providers?.[providerName]?.settings;
  return settings && typeof settings === "object" ? settings : null;
}

export function getClineProviderBaseUrl(configText, providerName = CLINE_PROVIDER) {
  return parseProvidersJson(configText, providerName)?.baseUrl ?? null;
}

// Exported so callers (gateway-companion.mjs) can fold cline's own credential
// into the run's redaction set — it's read from providers.json, never
// injected via env, so nothing else in the codebase's secret-collection
// knows about it.
export function getClineProviderApiKey(configText, providerName = CLINE_PROVIDER) {
  return parseProvidersJson(configText, providerName)?.apiKey ?? null;
}

export function clinePreflightError(profile, configText) {
  if (configText == null) {
    return `cline config not found (~/.cline/data/settings/providers.json). ${CLINE_SETUP_HINT}`;
  }
  const baseUrl = getClineProviderBaseUrl(configText);
  if (baseUrl == null) {
    return `cline has no "${CLINE_PROVIDER}" provider configured. ${CLINE_SETUP_HINT}`;
  }
  if (!sameOriginAllowingV1(baseUrl, profile.baseUrl)) {
    return `cline provider "${CLINE_PROVIDER}" points at ${originOnly(baseUrl)} but profile "${profile.name}" expects ${originOnly(profile.baseUrl)}. ${CLINE_SETUP_HINT}`;
  }
  return null;
}

export function buildClineEnv(profile) {
  // No credential injection: cline reads its api key from providers.json
  // itself, not from the environment. profile.apiKey/authToken are unused here.
  const env = pickEnv(process.env);
  if (profile.subprocessEnv) {
    Object.assign(env, sanitizeSubprocessEnv(profile.subprocessEnv));
  }
  return env;
}

// A prompt with no whitespace at all is misread by cline's own arg parser as
// an attempted subcommand (verified — see file header). A leading space is
// semantically inert (any reasonable model trims it) and side-steps the bug
// without altering the prompt's actual content.
function clinePromptArg(prompt) {
  return /\s/.test(prompt) ? prompt : ` ${prompt}`;
}

export function buildClineArgs(model, prompt, { write = true } = {}) {
  return [
    "--json",
    "--provider", CLINE_PROVIDER,
    "--model", model,
    "--auto-approve", write ? "true" : "false",
    // "--" end-of-options sentinel: verified live that a prompt whose text
    // starts with "-"/"--" (e.g. a task literally about a CLI flag) is
    // otherwise parsed by cline's own Commander CLI as an unknown option and
    // rejected before any task runs (`error: unknown option '--foo ...'`).
    // spawn()'s argv array already rules out shell injection; this closes
    // the separate argument-injection gap in cline's OWN parser. Confirmed
    // it composes cleanly with the leading-space workaround above.
    "--",
    clinePromptArg(prompt)
  ];
}

export function parseClineStream(raw) {
  const events = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt && typeof evt === "object") events.push(evt);
    } catch {
      // partial or corrupt line (e.g. process killed mid-write) — skip, never throw
    }
  }
  const results = events.filter((e) => e.type === "run_result");
  const last = results.at(-1) ?? null;
  // Only trust .text when the run actually finished cleanly. Verified live:
  // a read-only run (--auto-approve false) whose model retries tool calls
  // enough times can end with a run_result event that HAS finishReason
  // "aborted" ("aborted by another client" — misleading, no other process
  // involved) and text:"" — a genuinely empty answer would look identical
  // without this check, so an aborted run must never be read as "the model
  // said nothing," it must fail loud instead.
  const completed = last != null && last.finishReason === "completed" && typeof last.text === "string";
  return {
    finalText: completed ? last.text : null,
    hasFinal: completed,
    finishReason: last?.finishReason ?? null
  };
}

function appendLine(base, line) {
  return base ? (base.endsWith("\n") ? base + line : `${base}\n${line}`) : line;
}

export function shapeClineResult({ code, signal, stdout, stderr }) {
  const parsed = parseClineStream(stdout);
  const exitCode = code === 0 && !parsed.hasFinal ? 1 : (code ?? 1);
  let finalStdout = "";
  let finalStderr = stderr;
  if (parsed.hasFinal) {
    finalStdout = parsed.finalText;
  } else if ((code ?? 1) === 0) {
    // exited clean but the stream never carried a genuinely completed
    // run_result — anomalous, fail loud (parity with kimi/zero-harness.mjs).
    // A non-zero exit with no JSON stream is the ordinary CLI-usage-error
    // path (bad provider, misparsed prompt, etc.) — stderr already holds
    // cline's own human-readable message there, so nothing to append.
    const detail = parsed.finishReason && parsed.finishReason !== "completed"
      ? `finishReason: ${parsed.finishReason}`
      : "no run_result event";
    finalStderr = appendLine(finalStderr, `cline did not complete (${detail}) — raw stream preserved in rawJsonl/task log`);
  }
  return { stdout: finalStdout, stderr: finalStderr, exitCode, signal: signal ?? null, rawJsonl: stdout };
}

export async function runClineTask(profile, prompt, opts = {}) {
  if (opts.fork) {
    throw new Error("cline harness does not support fork");
  }
  if (opts.resume) {
    throw new Error("cline harness does not support resume (--id is broken in non-interactive --json mode as of the installed CLI version)");
  }

  const model = opts.model || profile.defaultModel;
  const configText = readClineConfig(getClineConfigPath());
  const preflightFailure = clinePreflightError(profile, configText);
  if (preflightFailure) {
    return { stdout: "", stderr: preflightFailure, exitCode: 1, signal: null, rawJsonl: "" };
  }

  const args = buildClineArgs(model, prompt, { write: opts.write !== false });
  const env = buildClineEnv(profile);
  const proc = spawn("cline", args, {
    cwd: opts.cwd || process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
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

  let onAbort = null;
  if (opts.signal) {
    onAbort = () => { try { terminateProcessTree(proc.pid); } catch { /* tree already gone */ } }; // blocks ~2s (SIGTERM grace) like the codex harness
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const detachAbort = () => {
    if (onAbort) opts.signal.removeEventListener("abort", onAbort);
  };

  return new Promise((resolve, reject) => {
    let exitCode = null;
    let exitSignal = null;
    proc.on("error", (err) => {
      detachAbort();
      reject(err);
    });
    proc.on("exit", (code, sig) => { exitCode = code; exitSignal = sig; });
    // Settle on "close" (stdout/stderr fully drained), not "exit" — parity
    // with codex-harness.mjs / zero-harness.mjs / kimi-harness.mjs.
    proc.on("close", (code, sig) => {
      detachAbort();
      if (stdoutBuf && opts.onStdout) { opts.onStdout(stdoutBuf); stdoutBuf = ""; }
      resolve(shapeClineResult({ code: exitCode ?? code, signal: exitSignal ?? sig, stdout, stderr }));
    });
  });
}
