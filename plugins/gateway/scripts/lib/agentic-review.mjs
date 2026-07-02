/**
 * Agentic review loop — multi-turn tool-use driver for /gateway:review.
 * Model reads repo context incrementally via read-only git/fs tools.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { chatCompletion } from "./api-client.mjs";

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
      description: "Show git diff for the review target. Use paths[] to filter to specific files when the diff is large.",
      parameters: {
        type: "object",
        properties: {
          base: { type: "string", description: "Base ref to diff against (e.g. 'main', 'HEAD~1')" },
          staged: { type: "boolean", description: "Show staged (cached) changes only" },
          paths: { type: "array", items: { type: "string" }, description: "Limit diff to these file paths" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_changed_files",
      description: "List files changed in the review target with their change type (M/A/D/R).",
      parameters: {
        type: "object",
        properties: {
          base: { type: "string", description: "Base ref to compare against" },
        },
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

async function dispatchTool(name, args, cwd, repoRoot) {
  try {
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
        const { base, staged, paths: filePaths } = args;
        if (base !== undefined && !VALID_REF.test(base)) return "Error: invalid ref";
        const gitArgs = ["diff"];
        if (staged) gitArgs.push("--cached");
        if (base) gitArgs.push(`${base}..HEAD`);
        if (filePaths?.length) {
          for (const p of filePaths) {
            if (!VALID_PATH_COMPONENT.test(p)) return "Error: invalid path in paths[]";
            if (p.includes('..') || path.isAbsolute(p)) return "Error: invalid path in paths[]";
          }
          gitArgs.push("--", ...filePaths);
        }
        return runCommand("git", gitArgs, cwd);
      }

      case "list_changed_files": {
        const { base } = args;
        if (base !== undefined && !VALID_REF.test(base)) return "Error: invalid ref";
        const gitArgs = ["diff", "--name-status"];
        if (base) gitArgs.push(`${base}..HEAD`);
        return runCommand("git", gitArgs, cwd);
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

// ---------------------------------------------------------------------------
// Tool loop
// ---------------------------------------------------------------------------

async function forceFinish(profile, messages, opts) {
  const forced = [...messages, {
    role: "user",
    content: "You must now produce your final review as valid JSON only. No tool calls.",
  }];
  const response = await chatCompletion(profile, forced, {
    model: opts.model,
    response_format: { type: "json_object" },
    timeoutMs: opts.timeoutMs,
  });
  const msg = response.choices[0].message;
  return { content: msg.content ?? "", messages: [...forced, msg] };
}

export async function runToolLoop(profile, messages, tools, opts = {}) {
  const maxIterations = opts.maxIterations ?? 10;
  const maxTime = opts.maxTime ?? 120_000;
  const deadline = Date.now() + maxTime;
  let msgs = [...messages];

  for (let i = 0; i < maxIterations; i++) {
    if (Date.now() > deadline) return forceFinish(profile, msgs, opts);

    const response = await chatCompletion(profile, msgs, {
      model: opts.model,
      tools,
      tool_choice: "auto",
      timeoutMs: opts.timeoutMs,
    });
    const choice = response.choices[0];
    msgs = [...msgs, choice.message];

    const reason = choice.finish_reason;

    if (reason === "stop" || reason === "length" || reason === "content_filter" || !reason) {
      return { content: choice.message.content ?? "", messages: msgs };
    }

    if (reason === "tool_calls") {
      for (const tc of choice.message.tool_calls ?? []) {
        let args;
        try { args = JSON.parse(tc.function.arguments); }
        catch { args = null; }
        const result = args === null
          ? "Error: malformed JSON arguments"
          : await dispatchTool(tc.function.name, args, opts.cwd, opts.repoRoot);
        msgs = [...msgs, { role: "tool", tool_call_id: tc.id, content: String(result) }];
      }
    } else {
      return { content: choice.message.content ?? "", messages: msgs };
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
- Always use the base ref provided in the initial message for git_diff and list_changed_files.
- Your final message must be valid JSON only — the caller will JSON.parse it directly.`;

/**
 * Run an agentic review for the given target.
 * Returns { content: string, messages: array }.
 * content is the model's final message (expected to be valid JSON).
 */
export async function runAgenticReview(profile, cwd, target, opts = {}) {
  const repoRoot = (await runCommand("git", ["rev-parse", "--show-toplevel"], cwd)).trim();
  if (!repoRoot || repoRoot.startsWith("Error:")) throw new Error("Not a git repository: " + cwd);

  const baseInstruction = target.baseRef
    ? `For all git_diff and list_changed_files calls use base="${target.baseRef}".`
    : "Compare against the working tree (no base ref provided).";

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
        baseInstruction,
        "Start by calling list_changed_files to understand the scope.",
      ].filter(Boolean).join("\n"),
    },
  ];

  return runToolLoop(profile, messages, GIT_TOOLS, {
    ...opts,
    cwd,
    repoRoot,
  });
}
