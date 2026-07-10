// Zero harness — one-shot task delegation via the zero CLI (github.com/Gitlawb/zero).
// Structurally mirrors codex-harness.mjs, with deliberate differences (spec rev 2):
//  - stdout carries the extracted `final` text; the full JSONL stream is in rawJsonl
//  - fail-loud: no fallback to claude when zero is missing (callers enforce)
//  - zero's provider is global per machine — preflight compares it to the profile
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pickEnv, sanitizeSubprocessEnv, terminateProcessTree } from "./subprocess-utils.mjs";

export const READ_TOOLS = [
  "glob", "grep", "read_file", "read_minified_file",
  "list_directory", "lsp_navigate", "update_plan"
];
export const WRITE_TOOLS = ["edit_file", "write_file", "apply_patch", "bash", "exec_command"];

// Sync on purpose (execSync makes it sync anyway) — unlike isCodexAvailable(),
// which is declared async for historical reasons. Callers do NOT await this.
export function isZeroAvailable() {
  try {
    execSync("zero --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function getZeroConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "zero", "config.json");
}

// Cached per process: a dispatch spawns N tasks and the provider must be
// consistent across all of them (TOCTOU guard vs a concurrent `zero setup`).
let providerCache;

export function _resetZeroProviderCache() {
  providerCache = undefined;
}

export function getZeroProvider({ refresh = false } = {}) {
  if (providerCache !== undefined && !refresh) return providerCache;
  providerCache = null;
  try {
    const config = JSON.parse(fs.readFileSync(getZeroConfigPath(), "utf8"));
    const provider = Array.isArray(config.providers)
      ? config.providers.find((p) => p && p.name === config.activeProvider)
      : null;
    if (provider?.baseURL) {
      providerCache = {
        name: provider.name,
        baseURL: provider.baseURL,
        model: provider.model ?? null,
        apiKeyEnv: provider.apiKeyEnv ?? null,
        apiKeyStored: Boolean(provider.apiKeyStored),
        providerKind: provider.provider_kind ?? null
      };
    }
  } catch {
    providerCache = null;
  }
  return providerCache;
}

export function buildZeroEnv(profile, provider = null) {
  const env = pickEnv(process.env);
  if (profile.subprocessEnv) {
    Object.assign(env, sanitizeSubprocessEnv(profile.subprocessEnv));
  }
  // Assigned AFTER subprocessEnv on purpose: the credential must always win.
  const keyVar = provider?.apiKeyEnv || "GATEWAY_API_KEY";
  env[keyVar] = profile.apiKey || profile.authToken || "";
  return env;
}

export function urlsMatch(a, b) {
  const norm = (u) => {
    try {
      const url = new URL(u);
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      return `${url.protocol}//${url.hostname.toLowerCase()}:${port}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return String(u ?? "").trim().replace(/\/+$/, "").toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

export function buildZeroArgs(model, { write = true, cwd = null, promptFile }) {
  const tools = write ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  const args = [
    "exec", "-o", "json", "-m", model, "-f", promptFile,
    "--enabled-tools", tools.join(",")
  ];
  // Write tools stay permission-gated in headless zero without the bypass flag.
  args.push(...(write ? ["--auto", "medium", "--skip-permissions-unsafe"] : ["--auto", "low"]));
  if (cwd) args.push("-C", cwd);
  return args;
}

export function parseZeroJsonl(raw) {
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
  const finals = events.filter((e) => e.type === "final");
  const errors = events.filter((e) => e.type === "error");
  const usageEvt = events.filter((e) => e.type === "usage").at(-1) ?? null;
  return {
    finalText: finals.length > 0 ? String(finals.at(-1).text ?? "") : null,
    hasFinal: finals.length > 0,
    errorLines: errors.map((e) => `[zero error ${e.code ?? "unknown"}] ${e.message ?? ""}`.trimEnd()),
    usage: usageEvt
      ? {
          promptTokens: usageEvt.promptTokens ?? usageEvt.prompt_tokens ?? null,
          completionTokens: usageEvt.completionTokens ?? usageEvt.completion_tokens ?? null,
          totalTokens: usageEvt.totalTokens ?? usageEvt.total_tokens ?? null
        }
      : null
  };
}

export function shapeZeroResult({ code, signal, stdout, stderr }) {
  const parsed = parseZeroJsonl(stdout);
  const appendLine = (base, line) =>
    base ? (base.endsWith("\n") ? base + line : `${base}\n${line}`) : line;

  // error events are NEVER dropped — appended for both final and no-final paths
  let finalStderr = stderr;
  for (const line of parsed.errorLines) {
    finalStderr = appendLine(finalStderr, line);
  }

  let finalStdout;
  if (parsed.hasFinal) {
    finalStdout = parsed.finalText;
  } else {
    // No final event: don't surface the raw JSONL as stdout (renderTaskResult prefers
    // non-empty stdout over the failure message). The full stream is still available
    // via the returned rawJsonl field (dispatch task logs use it).
    finalStdout = "";
    finalStderr = appendLine(finalStderr, "zero exec produced no final message — raw JSONL preserved in rawJsonl/task log");
  }

  return {
    stdout: finalStdout,
    stderr: finalStderr,
    // null exit (signal kill) must never read as success — dispatch does `exitCode ?? 0`
    // exit 0 with no final event is an anomalous stream — never report success (fail-loud)
    exitCode: code === 0 && !parsed.hasFinal ? 1 : (code ?? 1),
    signal: signal ?? null,
    rawJsonl: stdout,
    usage: parsed.usage
  };
}

const ZERO_INIT_FIX = "Fix: node plugins/gateway/scripts/gateway-companion.mjs setup zero-init";

export function zeroPreflightError(profile, provider) {
  if (!provider) {
    return `zero has no configured provider (config missing, unparseable, or no active provider). ${ZERO_INIT_FIX}`;
  }
  if (!urlsMatch(provider.baseURL, profile.baseUrl)) {
    return `zero provider "${provider.name}" points at ${provider.baseURL} but profile "${profile.name}" expects ${profile.baseUrl}. ${ZERO_INIT_FIX}`;
  }
  return null;
}

export async function runZeroTask(profile, prompt, opts = {}) {
  if (opts.resume || opts.fork) {
    throw new Error("zero harness does not support resume/fork");
  }

  const provider = getZeroProvider();
  const preflightFailure = zeroPreflightError(profile, provider);
  if (preflightFailure) {
    return { stdout: "", stderr: preflightFailure, exitCode: 1, signal: null, rawJsonl: "", usage: null };
  }

  const model = opts.model || profile.defaultModel;
  const promptFile = path.join(
    os.tmpdir(),
    `gateway-zero-prompt-${process.pid}-${crypto.randomUUID()}.md`
  );
  fs.writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
  const removePromptFile = () => {
    try { fs.unlinkSync(promptFile); } catch { /* already gone */ }
  };

  let proc;
  try {
    const args = buildZeroArgs(model, {
      write: opts.write !== false,
      cwd: opts.cwd ?? null,
      promptFile
    });
    const env = buildZeroEnv(profile, provider);
    proc = spawn("zero", args, {
      cwd: opts.cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
  } catch (err) {
    // sync spawn failure (e.g. EACCES) — the finally-equivalent for the pre-spawn window
    removePromptFile();
    throw err;
  }

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
    // guarded: a throwing kill must not leave the promise unsettled
    onAbort = () => { try { terminateProcessTree(proc.pid); } catch { /* tree already gone */ } }; // blocks ~2s (SIGTERM grace) like the codex harness
    // abort events don't replay for listeners attached after the fact — an already-aborted signal
    // would otherwise never fire and the spawned process would run uncancelled
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const detachAbort = () => {
    if (onAbort) opts.signal.removeEventListener("abort", onAbort);
  };

  return new Promise((resolve, reject) => {
    proc.on("error", (err) => {
      removePromptFile();
      detachAbort();
      reject(err);
    });
    proc.on("exit", (code, sig) => {
      removePromptFile();
      detachAbort();
      if (stdoutBuf && opts.onStdout) opts.onStdout(stdoutBuf);
      resolve(shapeZeroResult({ code, signal: sig, stdout, stderr }));
    });
  });
}
