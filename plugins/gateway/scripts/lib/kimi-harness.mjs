// Kimi harness — one-shot/resumable task delegation via the kimi-code CLI
// (moonshotai/kimi-code). Structurally mirrors zero-harness.mjs, with
// deliberate differences:
//  - kimi's provider/model config lives in a global ~/.kimi-code/config.toml
//    (TOML, not JSON) that ALSO carries the api key inline — nothing is
//    injected via env at spawn time, unlike codex/claude/zero.
//  - the gateway plugin assumes a fixed provider alias "gateway" in that
//    file (same convention zero-init uses via --name gateway); models must
//    be pre-declared there as [models."gateway/<model>"] or kimi hard-fails.
//  - `-p/--prompt` takes the prompt as an argv value (not stdin); there is
//    no CLI-level read-only/sandbox flag, so write:false is unsupported —
//    fail loud rather than silently running with full tool access.
//  - stdout carries the extracted final assistant text; the full
//    stream-json stream is returned separately as rawJsonl (same field name
//    dispatch.mjs already looks for from zero-harness.mjs).
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pickEnv, sanitizeSubprocessEnv, terminateProcessTree, sameOriginAllowingV1, originOnly } from "./subprocess-utils.mjs";

export const KIMI_PROVIDER = "gateway";
const KIMI_SETUP_HINT = "Configure it manually in ~/.kimi-code/config.toml — see README.md (Kimi harness setup).";

// Sync on purpose (execSync makes it sync anyway) — matches isZeroAvailable().
export function isKimiAvailable() {
  try {
    execSync("kimi --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function getKimiConfigPath(env = process.env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".kimi-code", "config.toml");
}

export function readKimiConfig(configPath) {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
}

// Minimal TOML section splitter — only ever need to look up a couple of
// scalar keys inside named sections, not full TOML semantics. Bare
// `[section]` headers only (an optional trailing `# comment` is tolerated,
// same as real TOML); `[[array.tables]]` lines (e.g. kimi's own `[[hooks]]`
// blocks) never match and are safely ignored (read-only).
function tomlSections(text) {
  const sections = new Map();
  let current = null;
  let buf = [];
  const flush = () => { if (current !== null) sections.set(current, buf.join("\n")); };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\[([^[\]]+)\]\s*(#.*)?$/);
    if (m) {
      flush();
      current = m[1];
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

// TOML allows both "double" and 'single' (literal) quoted strings.
function tomlScalar(body, key) {
  const m = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m"));
  return m ? (m[1] ?? m[2]) : null;
}

export function getKimiProviderBaseUrl(configText, providerName = KIMI_PROVIDER) {
  if (typeof configText !== "string") return null;
  const body = tomlSections(configText).get(`providers.${providerName}`);
  if (body == null) return null;
  return tomlScalar(body, "base_url");
}

// Exported so callers (gateway-companion.mjs) can fold kimi's own credential
// into the run's redaction set — it's read from config.toml, never injected
// via env, so nothing else in the codebase's secret-collection knows about it.
export function getKimiProviderApiKey(configText, providerName = KIMI_PROVIDER) {
  if (typeof configText !== "string") return null;
  const body = tomlSections(configText).get(`providers.${providerName}`);
  if (body == null) return null;
  return tomlScalar(body, "api_key");
}

export function kimiModelDeclared(configText, modelKey) {
  if (typeof configText !== "string") return false;
  return tomlSections(configText).has(`models."${modelKey}"`);
}

export function kimiPreflightError(profile, model, configText) {
  if (configText == null) {
    return `kimi config not found (~/.kimi-code/config.toml). ${KIMI_SETUP_HINT}`;
  }
  const baseUrl = getKimiProviderBaseUrl(configText);
  if (baseUrl == null) {
    return `kimi has no "[providers.${KIMI_PROVIDER}]" entry in config.toml. ${KIMI_SETUP_HINT}`;
  }
  if (!sameOriginAllowingV1(baseUrl, profile.baseUrl)) {
    return `kimi provider "${KIMI_PROVIDER}" points at ${originOnly(baseUrl)} but profile "${profile.name}" expects ${originOnly(profile.baseUrl)}. ${KIMI_SETUP_HINT}`;
  }
  const modelKey = `${KIMI_PROVIDER}/${model}`;
  if (!kimiModelDeclared(configText, modelKey)) {
    return `model "${modelKey}" is not declared in kimi's config.toml — add a [models."${modelKey}"] entry. ${KIMI_SETUP_HINT}`;
  }
  return null;
}

export function buildKimiEnv(profile) {
  // No credential injection: kimi reads its api_key from config.toml itself,
  // not from the environment. profile.apiKey/authToken are unused here.
  const env = pickEnv(process.env);
  if (profile.subprocessEnv) {
    Object.assign(env, sanitizeSubprocessEnv(profile.subprocessEnv));
  }
  return env;
}

export function buildKimiArgs(model, prompt, { resume = false } = {}) {
  const args = ["-p", prompt, "-m", `${KIMI_PROVIDER}/${model}`, "--output-format", "stream-json"];
  if (resume) args.push("-c");
  return args;
}

export function parseKimiStream(raw) {
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
  // A tool-calling assistant turn has no "content" key at all; only a final
  // answer carries one (possibly ""), so presence — not truthiness — of the
  // key is what marks it final.
  const finals = events.filter((e) => e.role === "assistant" && typeof e.content === "string");
  return {
    finalText: finals.length > 0 ? finals.at(-1).content : null,
    hasFinal: finals.length > 0
  };
}

function appendLine(base, line) {
  return base ? (base.endsWith("\n") ? base + line : `${base}\n${line}`) : line;
}

export function shapeKimiResult({ code, signal, stdout, stderr }) {
  const parsed = parseKimiStream(stdout);
  const exitCode = code === 0 && !parsed.hasFinal ? 1 : (code ?? 1);
  let finalStdout = "";
  let finalStderr = stderr;
  if (parsed.hasFinal) {
    finalStdout = parsed.finalText;
  } else if ((code ?? 1) === 0) {
    // exited clean but the stream never carried a final assistant message —
    // anomalous, fail loud (parity with zero-harness.mjs). A non-zero exit
    // with no JSON stream is the ordinary CLI-usage-error path (bad model,
    // etc.) — stderr already holds kimi's own human-readable message there,
    // so nothing to append.
    finalStderr = appendLine(finalStderr, "kimi produced no final assistant message — raw stream preserved in rawJsonl/task log");
  }
  return { stdout: finalStdout, stderr: finalStderr, exitCode, signal: signal ?? null, rawJsonl: stdout };
}

export async function runKimiTask(profile, prompt, opts = {}) {
  if (opts.fork) {
    throw new Error("kimi harness does not support fork");
  }
  if (opts.write === false) {
    throw new Error("kimi harness does not support --no-write (no CLI-level read-only mode)");
  }

  const model = opts.model || profile.defaultModel;
  const configText = readKimiConfig(getKimiConfigPath());
  const preflightFailure = kimiPreflightError(profile, model, configText);
  if (preflightFailure) {
    return { stdout: "", stderr: preflightFailure, exitCode: 1, signal: null, rawJsonl: "" };
  }

  const args = buildKimiArgs(model, prompt, { resume: Boolean(opts.resume) });
  const env = buildKimiEnv(profile);
  const proc = spawn("kimi", args, {
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
    // with codex-harness.mjs / zero-harness.mjs.
    proc.on("close", (code, sig) => {
      detachAbort();
      if (stdoutBuf && opts.onStdout) { opts.onStdout(stdoutBuf); stdoutBuf = ""; }
      resolve(shapeKimiResult({ code: exitCode ?? code, signal: exitSignal ?? sig, stdout, stderr }));
    });
  });
}
