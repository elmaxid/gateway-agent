// Codex harness — alternative to claude subprocess for stateful tasks.
// Uses OPENAI_BASE_URL/OPENAI_API_KEY (not ANTHROPIC_*).
// Falls back to claude subprocess if codex CLI not installed.
import { spawn, execSync } from "node:child_process";
import process from "node:process";

const ENV_WHITELIST = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "NODE_PATH", "TMPDIR", "TMP", "TEMP"
];

function pickEnv(source) {
  const picked = {};
  for (const key of ENV_WHITELIST) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  for (const key of Object.keys(source)) {
    if (key.startsWith("XDG_")) picked[key] = source[key];
  }
  return picked;
}

function terminateProcessTree(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already dead
    }
  }
}

export function buildCodexEnv(profile) {
  const env = pickEnv(process.env);
  env.OPENAI_BASE_URL = profile.baseUrl;
  env.OPENAI_API_KEY = profile.apiKey || profile.authToken || "";
  if (profile.subprocessEnv) {
    Object.assign(env, profile.subprocessEnv);
  }
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
    args = ["exec", "--json", "--ephemeral", "-m", model, "-s", sandbox];
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
    const onAbort = () => terminateProcessTree(proc.pid);
    opts.signal.addEventListener("abort", onAbort, { once: true });
    proc.on("exit", () => opts.signal.removeEventListener("abort", onAbort));
  }

  return new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code, sig) => {
      if (stdoutBuf && opts.onStdout) opts.onStdout(stdoutBuf);
      resolve({ stdout, stderr, exitCode: code, signal: sig });
    });
  });
}

export async function runTask(profile, prompt, opts = {}) {
  if (opts.harness === "codex" && await isCodexAvailable()) {
    return runCodexTask(profile, prompt, opts);
  }
  const { runClaudeTask } = await import("./claude-subprocess.mjs");
  return runClaudeTask(profile, prompt, opts);
}
