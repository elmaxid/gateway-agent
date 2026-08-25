import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runWindowsTaskkill(pid, options) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
    cwd: options.cwd,
    env: options.env
  });

  if (!result.error && result.status === 0) {
    return { attempted: true, delivered: true, method: "taskkill", result };
  }

  const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
  if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
    return { attempted: true, delivered: false, method: "taskkill", result };
  }

  if (result.error?.code === "ENOENT") {
    try {
      killImpl(pid);
      return { attempted: true, delivered: true, method: "kill" };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "kill" };
      }
      throw error;
    }
  }

  if (result.error) {
    throw result.error;
  }

  throw new Error(formatCommandFailure(result));
}

// Shared by the sync and async paths: send SIGTERM (process group first,
// falling back to just the pid), reporting how it went. No sleeping here —
// each path awaits/blocks for the grace period in its own idiomatic way.
function deliverTermSignal(pid, killImpl) {
  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process-group" };
    }
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

// Shared by the sync and async paths: after the grace period has elapsed,
// escalate to SIGKILL only if the process is still alive.
function escalateIfStillAlive(pid, method, killImpl) {
  let stillAlive = false;
  try {
    killImpl(pid, 0);
    stillAlive = true;
  } catch {
    // process already exited
  }

  if (!stillAlive) {
    return { attempted: true, delivered: true, method };
  }

  try {
    killImpl(-pid, "SIGKILL");
  } catch {
    try {
      killImpl(pid, "SIGKILL");
    } catch {
      // best effort — process may have exited between check and kill
    }
  }
  return { attempted: true, delivered: true, method: `${method}+sigkill` };
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return runWindowsTaskkill(pid, options);
  }

  const killImpl = options.killImpl ?? process.kill.bind(process);
  const signalResult = deliverTermSignal(pid, killImpl);
  if (!signalResult.delivered) {
    return signalResult;
  }

  syncSleep(options.gracePeriodMs ?? 2000);
  return escalateIfStillAlive(pid, signalResult.method, killImpl);
}

export async function terminateProcessTreeAsync(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // taskkill /F is immediate -- no grace-period step to genuinely await.
    return runWindowsTaskkill(pid, options);
  }

  const killImpl = options.killImpl ?? process.kill.bind(process);
  const signalResult = deliverTermSignal(pid, killImpl);
  if (!signalResult.delivered) {
    return signalResult;
  }

  // The actual bug fix: a REAL await, not a synchronous function call with a
  // Promise-returning argument it never awaits (which is what delegating to
  // terminateProcessTree with an async sleepImpl used to do — the grace
  // period effectively never happened, and SIGKILL landed right after
  // SIGTERM every time).
  await new Promise((resolve) => setTimeout(resolve, options.gracePeriodMs ?? 2000));
  return escalateIfStillAlive(pid, signalResult.method, killImpl);
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
