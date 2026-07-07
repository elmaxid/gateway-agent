import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Semaphore, normalizeBaseUrl } from "./concurrency.mjs";
import { generateJobId } from "./state.mjs";

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const TASK_HEADER_RE = /^##\s+Task\s+(\d+)[\s:>\-]/i;

export function parsePlanFile(content) {
  const lines = content.split(/\r?\n/);
  const tasks = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(TASK_HEADER_RE);
    if (match) {
      if (current) tasks.push(current);
      const id = parseInt(match[1], 10);
      current = { id, header: line, bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) tasks.push(current);

  if (tasks.length === 0) {
    throw new Error("No tasks found in plan file. Expected ## Task N headers.");
  }

  const seenIds = new Set();
  for (const t of tasks) {
    if (seenIds.has(t.id)) {
      throw new Error(`Duplicate task ID ${t.id} in plan file.`);
    }
    seenIds.add(t.id);
  }

  return tasks.map((t) => ({
    id: t.id,
    prompt: `${t.header}\n${t.bodyLines.join("\n")}`.trim(),
  }));
}

export function parseInlineTasks(taskArgs, defaultProfile) {
  return taskArgs.map((raw, index) => {
    const lastColon = raw.lastIndexOf(":");
    if (lastColon === -1 || lastColon === 0) {
      return { id: index + 1, prompt: raw, profile: defaultProfile };
    }
    const afterColon = raw.slice(lastColon + 1).trim();
    if (afterColon.includes("/") || afterColon.includes(" ")) {
      return { id: index + 1, prompt: raw, profile: defaultProfile };
    }
    return {
      id: index + 1,
      prompt: raw.slice(0, lastColon).trim(),
      profile: afterColon || defaultProfile,
    };
  });
}

export function parseAssignment(assignStr, taskCount) {
  const assigned = new Map();
  const segments = assignStr.split(",").map((s) => s.trim()).filter(Boolean);

  for (const segment of segments) {
    const colonIdx = segment.lastIndexOf(":");
    if (colonIdx === -1) {
      throw new Error(`Invalid assignment segment "${segment}". Expected "range:profile".`);
    }
    const rangeStr = segment.slice(0, colonIdx).trim();
    const profile = segment.slice(colonIdx + 1).trim();
    if (!profile) {
      throw new Error(`Empty profile in assignment segment "${segment}".`);
    }

    const dashIdx = rangeStr.indexOf("-");
    let start, end;
    if (dashIdx === -1) {
      start = end = parseInt(rangeStr, 10);
    } else {
      start = parseInt(rangeStr.slice(0, dashIdx), 10);
      end = parseInt(rangeStr.slice(dashIdx + 1), 10);
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
      throw new Error(`Invalid range "${rangeStr}" in assignment. Expected positive integers.`);
    }
    if (start > end) {
      throw new Error(`Invalid range "${rangeStr}": start (${start}) > end (${end}).`);
    }
    if (end > taskCount) {
      throw new Error(`Assignment range ${start}-${end} exceeds task count (${taskCount}).`);
    }

    for (let i = start; i <= end; i++) {
      if (assigned.has(i)) {
        throw new Error(`Overlapping assignment: task ${i} assigned to both "${assigned.get(i)}" and "${profile}".`);
      }
      assigned.set(i, profile);
    }
  }

  return assigned;
}

export function parseModelOverrides(overrideArgs) {
  const map = new Map();
  for (const arg of overrideArgs) {
    const colonIdx = arg.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(`Invalid --model-override "${arg}". Expected "profile:model".`);
    }
    map.set(arg.slice(0, colonIdx).trim(), arg.slice(colonIdx + 1).trim());
  }
  return map;
}

export function buildTaskList(rawTasks, assignment, overrides, defaultProfile) {
  return rawTasks.map((t) => {
    const profile = t.profile ?? assignment?.get(t.id) ?? defaultProfile;
    const model = (profile && overrides?.get(profile)) ?? null;
    return { id: t.id, prompt: t.prompt, profile, model };
  });
}

// ---------------------------------------------------------------------------
// Worktree lifecycle
// ---------------------------------------------------------------------------

export function createWorktree(repoRoot, worktreePath, baseSha) {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync(
    "git",
    ["worktree", "add", "--detach", worktreePath, baseSha],
    { cwd: repoRoot, stdio: "ignore" }
  );
}

export function removeWorktree(repoRoot, worktreePath) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    process.stderr.write(`[dispatch] Warning: orphaned worktree at ${worktreePath}\n`);
  }
}

export function collectPatch(worktreePath) {
  const untracked = execSync("git ls-files --others --exclude-standard", {
    cwd: worktreePath,
    encoding: "utf8",
  }).trim();
  if (untracked) {
    execSync("git add --intent-to-add .", { cwd: worktreePath, stdio: "ignore" });
  }
  return execSync("git diff --binary HEAD", {
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

export function ensureDispatchGitignore(repoRoot) {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const entry = ".gateway-dispatch/";
  let content = "";
  try { content = fs.readFileSync(gitignorePath, "utf8"); } catch {}
  if (!content.split("\n").some((line) => line.trim() === entry)) {
    fs.appendFileSync(gitignorePath, `${content.endsWith("\n") || !content ? "" : "\n"}${entry}\n`);
  }
}

export function cleanOrphanedWorktrees(repoRoot) {
  const dispatchDir = path.join(repoRoot, ".gateway-dispatch");
  if (!fs.existsSync(dispatchDir)) return;
  for (const jobDir of fs.readdirSync(dispatchDir)) {
    const wtDir = path.join(dispatchDir, jobDir, "worktrees");
    if (!fs.existsSync(wtDir)) continue;
    for (const taskDir of fs.readdirSync(wtDir)) {
      const wtPath = path.join(wtDir, taskDir);
      try {
        removeWorktree(repoRoot, wtPath);
        process.stderr.write(`[dispatch] Cleaned orphaned worktree: ${wtPath}\n`);
      } catch {}
    }
    try { fs.rmSync(path.join(dispatchDir, jobDir), { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Execution engine
// ---------------------------------------------------------------------------

function padTaskId(id) {
  return String(id).padStart(3, "0");
}

export async function runDispatch(tasks, opts) {
  const {
    cwd,
    harness = "codex",
    write = true,
    maxConcurrency = 3,
    timeoutMs,
    failFast = false,
    crossReview = null,
    crossReviewModel = null,
    taskRunner,
    resolveProfileFn,
    skipPreflight = false,
    onProgress,
    dryRun = false,
  } = opts;

  const repoRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8" }).trim();
  const baseSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const jobId = generateJobId("dispatch");
  const outputDir = path.join(repoRoot, ".gateway-dispatch", jobId);

  ensureDispatchGitignore(repoRoot);
  cleanOrphanedWorktrees(repoRoot);

  if (dryRun) {
    return { jobId, baseSha, outputDir, tasks: tasks.map((t) => ({ ...t, status: "pending" })), summary: { total: tasks.length } };
  }

  fs.mkdirSync(path.join(outputDir, "patches"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "logs"), { recursive: true });

  const globalAc = new AbortController();
  const createdWorktrees = new Set();
  let aborted = false;

  const onSignal = () => {
    aborted = true;
    globalAc.abort();
    for (const wt of createdWorktrees) {
      removeWorktree(repoRoot, wt);
    }
  };
  process.on("SIGINT", onSignal);

  const semaphores = new Map();
  const getSemaphore = (baseUrl) => {
    const key = normalizeBaseUrl(baseUrl);
    if (!semaphores.has(key)) semaphores.set(key, new Semaphore(maxConcurrency));
    return semaphores.get(key);
  };

  const results = [];
  let failedCount = 0;

  const taskPromises = tasks.map((task) => {
    const profile = resolveProfileFn(task.profile);
    const sem = getSemaphore(profile.baseUrl);
    const taskPad = padTaskId(task.id);

    return sem.run(async () => {
      if (aborted || (failFast && failedCount > 0)) {
        const result = { ...task, model: task.model, status: "failed", noChanges: false, duration: 0, patchFile: null, output: "", error: "aborted" };
        results.push(result);
        return result;
      }

      const start = Date.now();
      const wtPath = path.join(outputDir, "worktrees", `task-${task.id}`);
      const logFile = path.join(outputDir, "logs", `task-${taskPad}.log`);

      const taskAc = new AbortController();
      const onGlobalAbort = () => taskAc.abort();
      globalAc.signal.addEventListener("abort", onGlobalAbort, { once: true });

      let timeoutTimer;
      if (timeoutMs) {
        timeoutTimer = setTimeout(() => taskAc.abort(), timeoutMs);
      }

      try {
        createWorktree(repoRoot, wtPath, baseSha);
        createdWorktrees.add(wtPath);

        onProgress?.({ message: `Task ${task.id}: running (${profile.name}/${task.model || profile.defaultModel})`, phase: `task-${task.id}` });

        const model = task.model || profile.defaultModel;
        const runnerResult = await taskRunner(profile, task.prompt, {
          model,
          write,
          harness,
          cwd: wtPath,
          signal: taskAc.signal,
        });

        const rawOutput = runnerResult.stdout || "";
        const exitCode = runnerResult.exitCode ?? 0;

        if (exitCode !== 0) {
          failedCount++;
          const result = { ...task, model, status: "failed", noChanges: false, duration: Date.now() - start, patchFile: null, output: rawOutput, error: runnerResult.stderr || `exit ${exitCode}` };
          fs.writeFileSync(logFile, rawOutput + "\n" + (runnerResult.stderr || ""), "utf8");
          results.push(result);
          return result;
        }

        const patch = collectPatch(wtPath);
        const noChanges = !patch.trim();
        const patchFile = noChanges ? null : path.join(outputDir, "patches", `task-${taskPad}.patch`);
        if (patchFile) {
          fs.writeFileSync(patchFile, patch, "utf8");
        }
        fs.writeFileSync(logFile, rawOutput, "utf8");

        const status = noChanges ? "completed_no_changes" : "completed";
        const result = { ...task, model, status, noChanges, duration: Date.now() - start, patchFile, output: rawOutput, error: null };
        results.push(result);
        onProgress?.({ message: `Task ${task.id}: ${status} (${Math.round((Date.now() - start) / 1000)}s)${noChanges ? " (no changes)" : ""}`, phase: `task-${task.id}` });
        return result;
      } catch (err) {
        failedCount++;
        const result = { ...task, model: task.model, status: "failed", noChanges: false, duration: Date.now() - start, patchFile: null, output: "", error: err.message };
        results.push(result);
        return result;
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        globalAc.signal.removeEventListener("abort", onGlobalAbort);
        if (createdWorktrees.has(wtPath)) {
          removeWorktree(repoRoot, wtPath);
          createdWorktrees.delete(wtPath);
        }
      }
    });
  });

  await Promise.all(taskPromises);
  process.removeListener("SIGINT", onSignal);

  const completed = results.filter((r) => r.status === "completed").length;
  const completedNoChanges = results.filter((r) => r.status === "completed_no_changes").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const manifest = {
    jobId,
    baseSha,
    tasks: results.sort((a, b) => a.id - b.id),
    summary: { total: tasks.length, completed, completedNoChanges, failed },
  };

  fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { ...manifest, outputDir };
}
