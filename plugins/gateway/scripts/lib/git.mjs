import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function getHeadCommit(cwd) {
  return gitChecked(cwd, ["rev-parse", "HEAD"]).stdout.trim();
}

function buildBranchComparison(cwd, baseRef, target) {
  // target is always a resolved branch target, and buildBranchTarget always sets mergeBase —
  // no fallback re-resolution, which would defeat the point of pinning it at resolution time.
  const mergeBase = target.mergeBase;
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

function buildBranchTarget(cwd, baseRef, explicit) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  const headCommit = getHeadCommit(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${baseRef}`,
    baseRef,
    mergeBase,
    headCommit,
    explicit
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return buildBranchTarget(cwd, baseRef, true);
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    return buildBranchTarget(cwd, detectDefaultBranch(cwd), true);
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  return buildBranchTarget(cwd, detectDefaultBranch(cwd), false);
}

function parsePorcelainStatusZ(output) {
  const entries = [];
  const fields = output.split("\0");
  let i = 0;
  while (i < fields.length) {
    const record = fields[i];
    if (record === "") {
      i += 1;
      continue;
    }
    const indexCode = record[0];
    const worktreeCode = record[1];
    const path = record.slice(3);
    if (indexCode === "R" || indexCode === "C" || worktreeCode === "R" || worktreeCode === "C") {
      // A rename record must carry its source path in the next NUL field. Defaulting to "" here
      // would turn truncated git output into an inventory entry with a blank path — this module
      // treats git as authoritative, so malformed output fails instead of being invented around.
      const renameFrom = fields[i + 1];
      if (renameFrom === undefined || renameFrom === "") {
        throw new Error(`Malformed git status record: rename "${path}" has no source path`);
      }
      entries.push({ indexCode, worktreeCode, path, renameFrom });
      i += 2;
    } else {
      entries.push({ indexCode, worktreeCode, path, renameFrom: null });
      i += 1;
    }
  }
  return entries;
}

function parseNameStatusZ(output) {
  const entries = [];
  const fields = output.split("\0");
  let i = 0;
  while (i < fields.length) {
    const status = fields[i];
    if (status === "") {
      i += 1;
      continue;
    }
    const code = status[0];
    if (code === "R" || code === "C") {
      const renameFrom = fields[i + 1];
      const renamePath = fields[i + 2];
      if (!renameFrom || !renamePath) {
        throw new Error(`Malformed git name-status record: rename "${status}" is missing a path`);
      }
      entries.push({ code, renameFrom, path: renamePath });
      i += 3;
    } else {
      const path = fields[i + 1];
      if (!path) {
        throw new Error(`Malformed git name-status record: "${status}" has no path`);
      }
      entries.push({ code, renameFrom: null, path });
      i += 2;
    }
  }
  return entries;
}

function sortInventory(entries) {
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function buildWorkingTreeInventory(cwd) {
  const output = gitChecked(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  const entries = parsePorcelainStatusZ(output).map(({ indexCode, worktreeCode, path, renameFrom }) => ({
    path,
    index: indexCode === " " || indexCode === "?" ? null : indexCode,
    worktree: worktreeCode === " " || worktreeCode === "?" ? null : worktreeCode,
    renameFrom,
    untracked: indexCode === "?" && worktreeCode === "?"
  }));
  return sortInventory(entries);
}

// Branch mode passes --find-renames explicitly, which overrides the ambient diff.renames
// config; the working-tree side deliberately does not, so it still honors status.renames.
// The asymmetry is a recorded decision, not an oversight: a review of a branch should see a
// rename as a rename regardless of how the operator configured git, while the working-tree
// view stays faithful to what the operator's own `git status` would show them.
function buildBranchInventory(cwd, target) {
  const commitRange = `${target.mergeBase}..${target.headCommit}`;
  const output = gitChecked(cwd, ["diff", "--name-status", "-z", "--find-renames", commitRange]).stdout;
  const entries = parseNameStatusZ(output).map(({ code, path, renameFrom }) => ({
    path,
    index: code,
    worktree: null,
    renameFrom,
    untracked: false
  }));
  return sortInventory(entries);
}

export function buildTargetInventory(cwd, target) {
  if (target.mode === "working-tree") {
    return buildWorkingTreeInventory(cwd);
  }
  return buildBranchInventory(cwd, target);
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, inventory, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = inventory.map((entry) => entry.path);
  const staged = inventory.filter((entry) => entry.index !== null);
  const unstaged = inventory.filter((entry) => entry.worktree !== null);
  const untracked = inventory.filter((entry) => entry.untracked);

  // Unconditional since the evidence contract landed: collectReviewContext refuses before
  // reaching here when the diff cannot be sent whole, so there is no stats-only mode left.
  const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
  const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
  const untrackedBody = untracked.map((entry) => formatUntrackedFile(cwd, entry.path)).join("\n\n");
  const parts = [
    formatSection("Git Status", status),
    formatSection("Staged Diff", stagedDiff),
    formatSection("Unstaged Diff", unstagedDiff),
    formatSection("Untracked Files", untrackedBody)
  ];

  return {
    mode: "working-tree",
    summary: `Reviewing ${staged.length} staged, ${unstaged.length} unstaged, and ${untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, target, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, target.baseRef, target);
  const currentBranch = getCurrentBranch(cwd);
  const commitRange = `${target.mergeBase}..${target.headCommit}`;
  const changedFiles = options.inventory.map((entry) => entry.path);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${target.baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

/**
 * Refuse a review target that contains nothing to review.
 *
 * Lives here rather than inside collectReviewContext alone because the default agentic route
 * never calls the collector: it hands the model tools and lets it gather evidence itself. A
 * guard that only covered collector callers left the most-travelled route able to return an
 * approving verdict with exit 0 over an empty target — the exact outcome it exists to prevent.
 *
 * `inventory` is optional; pass it when the caller already built one to avoid a second walk.
 */
export function assertReviewTargetNonEmpty(repoRoot, target, inventory = null) {
  const entries = inventory ?? buildTargetInventory(repoRoot, target);
  if (entries.length === 0) {
    throw new Error(buildEmptyTargetError(target));
  }
  return entries;
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  const inventory = buildTargetInventory(repoRoot, target);
  assertReviewTargetNonEmpty(repoRoot, target, inventory);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (inventory.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    if (!includeDiff) {
      throw new Error(buildIncompleteEvidenceError(inventory.length, diffBytes, maxInlineFiles, maxInlineDiffBytes));
    }
    details = collectWorkingTreeContext(repoRoot, inventory, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef, target);
    const commitRange = `${target.mergeBase}..${target.headCommit}`;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (inventory.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    if (!includeDiff) {
      throw new Error(buildIncompleteEvidenceError(inventory.length, diffBytes, maxInlineFiles, maxInlineDiffBytes));
    }
    details = collectBranchContext(repoRoot, target, { includeDiff, comparison, inventory });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    ...details
  };
}

function buildEmptyTargetError(target) {
  return (
    `The review target "${target.label}" has no files to review: the resolved inventory is empty. ` +
    "A review with nothing to review cannot be distinguished from an approval, so it is refused before any model call.\n" +
    "To review something real, choose one of:\n" +
    "  - Compare against a different ref with --base <ref> (e.g. --base main).\n" +
    "  - Force a different scope with --scope working-tree (staged, unstaged, and untracked changes) or --scope branch.\n" +
    "If the thing you want reviewed is a document that git ignores (and so can never appear in any review target), " +
    "review it via delegation instead:\n" +
    "  gateway-companion task --no-write \"<prompt naming the file paths>\""
  );
}

function buildIncompleteEvidenceError(fileCount, diffBytes, maxInlineFiles, maxInlineDiffBytes) {
  return (
    "The direct review route cannot produce a complete review without the diff. " +
    `This change has ${fileCount} file(s) and ${diffBytes.toLocaleString("en-US")} byte(s) of diff, ` +
    `exceeding the inline evidence threshold (${maxInlineFiles} file(s) or ${maxInlineDiffBytes.toLocaleString("en-US")} byte(s)). ` +
    "Re-run with --include-diff to send the complete diff inline, or use the agentic review route " +
    "(gateway-companion review without --no-tools) which lets the model collect evidence with read-only tools."
  );
}
