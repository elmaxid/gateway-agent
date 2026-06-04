import { spawn } from "node:child_process";
import process from "node:process";
import { pickEnv, terminateProcessTree } from "./subprocess-utils.mjs";

export function buildSubprocessEnv(profile) {
  const env = pickEnv(process.env);
  if (profile.subprocessEnv) {
    Object.assign(env, profile.subprocessEnv);
  }
  env.ANTHROPIC_BASE_URL = profile.baseUrl;
  env.ANTHROPIC_API_KEY = profile.apiKey || "";
  env.ANTHROPIC_AUTH_TOKEN = profile.authToken || "";
  return env;
}

export function runClaudeTask(profile, prompt, opts = {}) {
  if (profile.kind !== "claude-gateway") {
    throw new Error(`Profile kind "${profile.kind}" cannot run tasks. Requires "claude-gateway".`);
  }

  const model = opts.model || profile.defaultModel;
  const args = ["-p", "--bare", "--model", model];
  if (opts.write !== false) {
    args.push("--allowedTools", "Bash,Read,Write,Edit,Glob,Grep");
  }

  const env = buildSubprocessEnv(profile);
  const proc = spawn("claude", args, {
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
