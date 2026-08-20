/**
 * Agentic review loop — multi-turn tool-use driver for /gateway:review.
 * Model reads repo context incrementally via read-only git/fs tools.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { chatCompletion, extractJson } from "./api-client.mjs";
import { buildTargetInventory } from "./git.mjs";

const MAX_OUTPUT_BYTES = 32 * 1024;
const TOOL_TIMEOUT_MS = 10_000;
const VALID_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/~^:]*$/;
const VALID_PATH_COMPONENT = /^[^\x00-\x1f]+$/;

export const GIT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a source file from the repository. Returns line-numbered content. Use start_line/end_line for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to repo root" },
          start_line: { type: "number", description: "First line to read (1-based, inclusive, optional)" },
          end_line: { type: "number", description: "Last line to read (1-based, inclusive, optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show the diff for the resolved review target (staged and unstaged changes). Use paths[] to filter to specific files when the diff is large.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Limit diff to these file paths" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_changed_files",
      description: "List files in the resolved review target with their index and worktree state, renames, and untracked files.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Show recent commit history as one-line summaries.",
      parameters: {
        type: "object",
        properties: {
          n: { type: "number", description: "Number of commits to show (default 10, max 50)" },
          branch: { type: "string", description: "Branch to show log for (default: current branch)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_show",
      description: "Show the full diff and metadata of a specific commit.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Commit ref or hash to inspect" },
        },
        required: ["ref"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, shell: false });
    const chunks = [];
    const errChunks = [];
    let totalBytes = 0;
    let errTotalBytes = 0;
    let done = false;

    const timer = setTimeout(() => {
      done = true;
      proc.kill();
      reject(new Error("timeout"));
    }, TOOL_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => {
      if (totalBytes < MAX_OUTPUT_BYTES) {
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
    });

    proc.stderr.on("data", (chunk) => {
      if (errTotalBytes < 4096) {
        errChunks.push(chunk);
        errTotalBytes += chunk.length;
      }
    });

    proc.on("close", (code) => {
      if (done) return;
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (code !== 0 && raw.trim() === "") {
        const errMsg = Buffer.concat(errChunks).toString("utf8").trim();
        resolve(errMsg ? `Error: ${errMsg}` : `Error: git exited ${code} (check ref/path validity)`);
        return;
      }
      const out = totalBytes >= MAX_OUTPUT_BYTES ? raw + "\n[truncated]" : raw;
      resolve(out);
    });

    proc.on("error", (err) => {
      if (done) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function formatInventory(inventory) {
  return inventory
    .map((entry) => {
      const status = entry.untracked ? "??" : `${entry.index ?? " "}${entry.worktree ?? " "}`;
      const displayPath = entry.renameFrom ? `${entry.renameFrom} -> ${entry.path}` : entry.path;
      return `${status}\t${displayPath}`;
    })
    .join("\n") + (inventory.length ? "\n" : "");
}

function validatePaths(filePaths) {
  if (!filePaths?.length) return { ok: true, pathArgs: [] };
  for (const p of filePaths) {
    if (!VALID_PATH_COMPONENT.test(p)) return { ok: false, error: "Error: invalid path in paths[]" };
    if (p.includes("..") || path.isAbsolute(p)) return { ok: false, error: "Error: invalid path in paths[]" };
  }
  return { ok: true, pathArgs: ["--", ...filePaths] };
}

// Fingerprint of the working tree used to detect mid-review mutation. Covers the porcelain
// status (structural changes and untracked files), the staged and unstaged diffs (content
// changes to tracked files that keep the same status code), and the size+mtime of every
// untracked file. That last part is not redundant: an untracked file's bytes appear in no diff
// and its status code stays "??" no matter what changes inside it, yet the system prompt tells
// the model to read every untracked file with read_file — so without this, the one class of
// file the model is told to rely on is the one class the guard could not see.
async function captureTreeFingerprint(repoRoot) {
  const status = await runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], repoRoot);
  const staged = await runCommand("git", ["diff", "--cached"], repoRoot);
  const unstaged = await runCommand("git", ["diff"], repoRoot);
  const untracked = await runCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"], repoRoot);
  const hash = createHash("sha256")
    .update(status)
    .update("\u0000")
    .update(staged)
    .update("\u0000")
    .update(unstaged);
  // Size and mtime rather than contents: this runs on every tool call, and a full re-read of
  // every untracked file would make the guard cost more than the review it protects.
  for (const rel of untracked.split("\u0000").filter(Boolean).sort()) {
    let stamp = "missing";
    try {
      const st = await fs.stat(path.join(repoRoot, rel));
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      /* raced with a delete — "missing" is itself a change worth hashing */
    }
    hash.update("\u0000").update(rel).update(":").update(stamp);
  }
  return hash.digest("hex");
}

async function dispatchTool(name, args, cwd, repoRoot, target, treeFingerprint) {
  try {
    if (treeFingerprint !== undefined) {
      const current = await captureTreeFingerprint(repoRoot);
      if (current !== treeFingerprint) {
        return "Error: the working tree changed during the review. The resolved target is no longer valid; re-run the review against the current tree.";
      }
    }

    switch (name) {
      case "read_file": {
        const { path: filePath, start_line, end_line } = args;
        if (start_line && end_line && start_line > end_line) return "Error: start_line must be <= end_line";
        const realRoot = await fs.realpath(repoRoot);
        let realPath;
        try {
          realPath = await fs.realpath(path.resolve(realRoot, filePath));
        } catch (err) {
          if (err.code === "ENOENT") return "Error: path not found";
          if (err.code === "EACCES") return "Error: permission denied";
          if (err.code === "ELOOP") return "Error: symlink loop detected";
          return `Error: ${err.code ?? err.message}`;
        }
        if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
          return "Error: path outside repository";
        }
        const buf = await fs.readFile(realPath);
        for (let i = 0; i < Math.min(buf.length, 512); i++) {
          if (buf[i] === 0) return "Error: binary file, cannot review";
        }
        const lines = buf.toString("utf8").split("\n");
        const start = start_line ? Math.max(1, start_line) : 1;
        const end = end_line ? Math.min(lines.length, end_line) : lines.length;
        const numbered = lines.slice(start - 1, end)
          .map((l, i) => `${start + i}: ${l}`)
          .join("\n");
        return numbered.length > MAX_OUTPUT_BYTES
          ? numbered.slice(0, MAX_OUTPUT_BYTES) + "\n[truncated]"
          : numbered;
      }

      case "git_diff": {
        const { paths: filePaths } = args;
        const { ok, error, pathArgs } = validatePaths(filePaths);
        if (!ok) return error;
        // repoRoot, not cwd: the paths the model filters by come from the inventory, which is
        // repo-root-relative. Resolved against a subdirectory they match nothing, and git exits
        // 0 on a pathspec that matches nothing — a silent empty diff over a valid-looking path.
        if (target.mode === "working-tree") {
          const staged = await runCommand("git", ["diff", "--cached", ...pathArgs], repoRoot);
          const unstaged = await runCommand("git", ["diff", ...pathArgs], repoRoot);
          return [staged, unstaged].filter((out) => out.trim() !== "").join("\n");
        }
        const range = `${target.mergeBase}..${target.headCommit}`;
        return runCommand("git", ["diff", range, ...pathArgs], repoRoot);
      }

      case "list_changed_files": {
        return formatInventory(buildTargetInventory(repoRoot, target));
      }

      case "git_log": {
        const { n = 10, branch } = args;
        if (branch !== undefined && !VALID_REF.test(branch)) return "Error: invalid ref";
        const count = Math.min(50, Math.max(1, n || 10));
        const gitArgs = ["log", "--oneline", `-${count}`];
        if (branch) gitArgs.push(branch);
        return runCommand("git", gitArgs, cwd);
      }

      case "git_show": {
        const { ref } = args;
        if (!ref) return "Error: ref is required";
        if (!VALID_REF.test(ref)) return "Error: invalid ref";
        return runCommand("git", ["show", ref], cwd);
      }

      default:
        return `Error: unknown tool '${name}'`;
    }
  } catch (err) {
    return err.message === "timeout" ? "Error: timeout" : `Error: ${err.message}`;
  }
}

// Minimal test seam for characterization coverage; production callers use runToolLoop.
export { dispatchTool as dispatchToolForTest, captureTreeFingerprint as captureTreeFingerprintForTest };

// ---------------------------------------------------------------------------
// Tool loop
// ---------------------------------------------------------------------------

async function requestTurn(profile, msgs, tools, opts) {
  const response = await chatCompletion(profile, msgs, {
    model: opts.model,
    tools,
    tool_choice: "auto",
    timeoutMs: opts.timeoutMs,
  });
  return response.choices[0];
}

// extractJson alone isn't enough: its brace-slicing fallback will happily
// parse a stray {...} fragment embedded in otherwise-malformed text (e.g.
// leftover tool-call arguments in a garbled native tool-call template) as
// "valid JSON", even though it isn't a review. Require the actual review
// schema fields the SYSTEM_PROMPT below asks for, not just parseability.
function isValidReviewPayload(content) {
  const { value, ok } = extractJson(content);
  if (!ok || value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof value.verdict === "string" && typeof value.summary === "string" && Array.isArray(value.findings);
}

async function forceFinish(profile, messages, opts) {
  const forced = [...messages, {
    role: "user",
    content: "You must now produce your final review as valid JSON only. No tool calls.",
  }];
  const callOnce = async () => {
    const response = await chatCompletion(profile, forced, {
      model: opts.model,
      response_format: { type: "json_object" },
      timeoutMs: opts.timeoutMs,
    });
    return response.choices[0].message;
  };

  let msg = await callOnce();
  let ok = isValidReviewPayload(msg.content ?? "");
  if (!ok) {
    // Model returned a non-review forced-completion instead of clean JSON
    // shaped like a review (observed intermittently with minimax-m3 — a
    // malformed native tool-call template leaking into content). The
    // failure is stochastic; retry once before giving up.
    msg = await callOnce();
    ok = isValidReviewPayload(msg.content ?? "");
  }
  return { content: msg.content ?? "", messages: [...forced, msg], ok };
}

export async function runToolLoop(profile, messages, tools, opts = {}) {
  const maxIterations = opts.maxIterations ?? 10;
  const maxTime = opts.maxTime ?? 120_000;
  const deadline = Date.now() + maxTime;
  let msgs = [...messages];

  for (let i = 0; i < maxIterations; i++) {
    if (Date.now() > deadline) return forceFinish(profile, msgs, opts);

    let choice = await requestTurn(profile, msgs, tools, opts);

    if (choice.finish_reason !== "tool_calls") {
      let ok = isValidReviewPayload(choice.message?.content ?? "");
      if (!ok) {
        // Model returned a non-tool_calls, non-review turn — e.g. a
        // malformed native tool-call template leaking into content instead
        // of the structured tool_calls field (observed intermittently with
        // minimax-m3, ~2/3 of the time in manual testing, no clear
        // correlation with context size). Retry this exact turn once before
        // giving up — the failure is stochastic, so a fresh attempt often
        // recovers, either with a valid review or with a proper tool_calls
        // turn.
        choice = await requestTurn(profile, msgs, tools, opts);
        ok = isValidReviewPayload(choice.message?.content ?? "");
      }
      if (choice.finish_reason !== "tool_calls") {
        msgs = [...msgs, choice.message];
        return { content: choice.message.content ?? "", messages: msgs, ok };
      }
    }

    msgs = [...msgs, choice.message];
    for (const tc of choice.message.tool_calls ?? []) {
      let args;
      try { args = JSON.parse(tc.function.arguments); }
      catch { args = null; }
      const result = args === null
        ? "Error: malformed JSON arguments"
        : await dispatchTool(tc.function.name, args, opts.cwd, opts.repoRoot, opts.target, opts.treeFingerprint);
      msgs = [...msgs, { role: "tool", tool_call_id: tc.id, content: String(result) }];
    }
  }

  return forceFinish(profile, msgs, opts);
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a code reviewer with read-only access to a git repository.
Use the provided tools to gather evidence, then produce a structured JSON review.

Workflow:
1. Call list_changed_files to understand the scope of the review target.
2. For each significant file, call git_diff (filtered by path) or read_file for deeper context.
3. Call git_log or git_show to understand intent when commit history is relevant.
4. When you have sufficient evidence, stop calling tools and respond with valid JSON only.

list_changed_files returns one line per file in the resolved target. Each line has two status
columns — the index state and the worktree state — followed by the path. A rename shows both
paths as "old -> new". Untracked files are marked "??"; they are not part of git_diff, so read
their content with read_file.

Output schema (respond with ONLY this JSON — no markdown fences, no prose):
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "<one paragraph summary of the changes and your overall assessment>",
  "findings": [
    {
      "file": "<relative file path>",
      "line_start": <line number or null>,
      "line_end": <line number or null>,
      "severity": "critical" | "warning" | "suggestion",
      "title": "<short finding title>",
      "body": "<detailed explanation>",
      "recommendation": "<specific fix recommendation>"
    }
  ],
  "next_steps": ["<optional follow-up action>"]
}

Rules:
- Always use start_line/end_line when reading large files — never request the whole file if you only need a section.
- Use paths[] in git_diff to filter to the file(s) you care about.
- Read the content of every untracked ("??") file with read_file — git_diff does not include them.
- Your final message must be valid JSON only — the caller will JSON.parse it directly.`;

/**
 * Run an agentic review for the given target.
 * Returns { content: string, messages: array, ok: boolean }.
 * content is the model's final message (expected to be valid JSON).
 * ok is false when the model returned malformed output twice in a row
 * instead of a valid JSON review — callers must check it before treating
 * content as a usable review.
 */
export async function runAgenticReview(profile, cwd, target, opts = {}) {
  const repoRoot = (await runCommand("git", ["rev-parse", "--show-toplevel"], cwd)).trim();
  if (!repoRoot || repoRoot.startsWith("Error:")) throw new Error("Not a git repository: " + cwd);

  const treeFingerprint = target.mode === "working-tree"
    ? await captureTreeFingerprint(repoRoot)
    : undefined;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Review target: ${target.label}`,
        `Mode: ${target.mode}`,
        target.baseRef ? `Base ref: ${target.baseRef}` : null,
        target.targetRef ? `Target ref: ${target.targetRef}` : null,
        "",
        "Start by calling list_changed_files to understand the scope.",
      ].filter(Boolean).join("\n"),
    },
  ];

  return runToolLoop(profile, messages, GIT_TOOLS, {
    ...opts,
    cwd,
    repoRoot,
    target,
    treeFingerprint,
  });
}
