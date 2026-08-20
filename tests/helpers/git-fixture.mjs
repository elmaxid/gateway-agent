/**
 * Deterministic git fixture builder for the test suite.
 *
 * Builds a temporary git repository with controlled, reproducible state so
 * that context-collection and review-target logic can be exercised against
 * every kind of change git can report. The helper never touches the real
 * repository: every repo it creates lives under the OS temp dir and is
 * removed by `cleanup()`.
 *
 * Conventions follow the rest of the suite (see tests/cli-timeout.test.mjs
 * and tests/baseline-capture.test.mjs): temp dirs via mkdtempSync under
 * os.tmpdir(), git driven through spawnSync, and cleanup via
 * fs.rmSync(..., { recursive: true, force: true }).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const GIT_IDENTITY = { email: "fixture@example.invalid", name: "Fixture Bot" };

/**
 * Runs git in `cwd` and returns stdout. Throws on non-zero exit so a
 * misconfigured fixture fails loudly instead of producing silent nonsense.
 */
export function runGit(cwd, args) {
  // NOTE: in some sandboxed CI environments spawnSync returns a spurious
  // `error` (e.g. EPERM) even when the child ran to completion with exit 0
  // and real stdout. The rest of the suite treats `status` as the source of
  // truth and ignores `error` when status is 0, so we do the same here.
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  const status = result.status;
  if (status === null || status === undefined) {
    throw new Error(
      `git ${args.join(" ")} did not run in ${cwd}: ${result.error ? result.error.message : "unknown error"}`
    );
  }
  if (status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${status}) in ${cwd}: ${(result.stderr || result.stdout || "").trim()}`
    );
  }
  return result.stdout;
}

function commit(repo, message) {
  runGit(repo, ["commit", "-q", "--allow-empty", "-m", message]);
}

/**
 * Creates a fresh, empty git repo under the OS temp dir with a deterministic
 * identity and an `--allow-empty` initial commit on `main`. Returns
 * `{ dir, cleanup }` where `cleanup()` removes the repo recursively.
 *
 * Callers are responsible for calling `cleanup()`, typically in a `finally`
 * block.
 */
export function createTempRepo(prefix = "git-fixture-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(dir, ["init", "-q", "--initial-branch=main"]);
  runGit(dir, ["config", "user.email", GIT_IDENTITY.email]);
  runGit(dir, ["config", "user.name", GIT_IDENTITY.name]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  // Assertions in the suite pin abbreviated object ids, byte counts and rename detection. All
  // three are configurable, and global config reaches a fresh repo, so a contributor with
  // core.abbrev=12 or diff.renames=false gets failures that point at the wrong thing. Pin them.
  runGit(dir, ["config", "core.abbrev", "7"]);
  runGit(dir, ["config", "diff.renames", "true"]);
  runGit(dir, ["config", "status.renames", "true"]);
  commit(dir, "initial empty commit");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function write(repo, relPath, contents) {
  const abs = path.join(repo, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/**
 * Builds a single repo containing every working-tree state the review path
 * must distinguish. Returns a manifest describing each path and the
 * porcelain v1 code it is expected to produce, so tests can assert against
 * git directly without trusting the builder's side effects.
 *
 * States produced:
 *  - staged file (index only)
 *  - tracked file modified in worktree, not staged
 *  - tracked file staged then modified again (index AND worktree differ)
 *  - untracked file
 *  - ignored file (matched by .gitignore)
 *  - rename with no further edits (pure rename, R100)
 *  - rename followed by edits (R<100)
 *  - deletion staged in the index
 *  - deletion only in the worktree
 *  - a path containing spaces (staged)
 *
 * `.gitignore` is committed in the base so it does not itself show up as
 * untracked; `ignored.txt` is created after the base commit.
 */
export function buildFixtureRepo(prefix = "git-fixture-") {
  const { dir, cleanup } = createTempRepo(prefix);

  // --- base commit: files that will be mutated later ---
  write(dir, ".gitignore", "ignored.txt\n");
  write(dir, "committed-modified.txt", "modified: base\n");
  write(dir, "committed-staged-then-modified.txt", "stm: base\n");
  write(dir, "rename-pure-old.txt", "rename pure: base\n");
  write(dir, "rename-edit-old.txt", "rename edit line 1\nrename edit line 2\nrename edit line 3\nrename edit line 4\nrename edit line 5\nrename edit line 6\nrename edit line 7\nrename edit line 8\n");
  write(dir, "delete-staged.txt", "delete staged: base\n");
  write(dir, "delete-worktree.txt", "delete worktree: base\n");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-q", "-m", "base committed files"]);

  // --- staged file (index only, not committed) ---
  write(dir, "staged-only.txt", "staged only\n");
  runGit(dir, ["add", "staged-only.txt"]);

  // --- tracked file modified in worktree, not staged ---
  write(dir, "committed-modified.txt", "modified: worktree change\n");

  // --- tracked file staged then modified again ---
  write(dir, "committed-staged-then-modified.txt", "stm: staged version\n");
  runGit(dir, ["add", "committed-staged-then-modified.txt"]);
  write(dir, "committed-staged-then-modified.txt", "stm: staged then modified again\n");

  // --- untracked file ---
  write(dir, "untracked.txt", "untracked\n");

  // --- ignored file (covered by committed .gitignore) ---
  write(dir, "ignored.txt", "ignored\n");

  // --- rename, pure (no further edits) ---
  runGit(dir, ["mv", "rename-pure-old.txt", "rename-pure-new.txt"]);

  // --- rename, then further edits ---
  runGit(dir, ["mv", "rename-edit-old.txt", "rename-edit-new.txt"]);
  write(dir, "rename-edit-new.txt", "rename edit line 1\nrename edit line 2\nrename edit line 3\nrename edit line 4 EDITED\nrename edit line 5\nrename edit line 6\nrename edit line 7\nrename edit line 8\n");
  runGit(dir, ["add", "rename-edit-new.txt"]);

  // --- deletion staged in the index ---
  runGit(dir, ["rm", "--", "delete-staged.txt"]);

  // --- deletion only in the worktree (not staged) ---
  rmSync(path.join(dir, "delete-worktree.txt"), { force: true });

  // --- path containing spaces, staged ---
  write(dir, "path with spaces/spaces-staged.txt", "spaces staged\n");
  runGit(dir, ["add", "path with spaces/spaces-staged.txt"]);

  return {
    dir,
    cleanup,
    branches: { current: "main" },
    files: {
      stagedOnly: { path: "staged-only.txt", porcelain: "A " },
      worktreeModified: { path: "committed-modified.txt", porcelain: " M" },
      stagedThenModified: { path: "committed-staged-then-modified.txt", porcelain: "MM" },
      untracked: { path: "untracked.txt", porcelain: "??" },
      ignored: { path: "ignored.txt" },
      renamePure: { path: "rename-pure-new.txt", oldPath: "rename-pure-old.txt", porcelain: "R " },
      renameEdit: { path: "rename-edit-new.txt", oldPath: "rename-edit-old.txt", porcelain: "R " },
      deleteStaged: { path: "delete-staged.txt", porcelain: "D " },
      deleteWorktree: { path: "delete-worktree.txt", porcelain: " D" },
      spacesStaged: { path: "path with spaces/spaces-staged.txt", porcelain: "A " },
    },
  };
}

/**
 * Builds a repo with a `feature` branch that diverged from `main`, where
 * `main` then advanced *after* the divergence. The repo is left checked out
 * on `feature`.
 *
 *    base (initial) -> shared base -> feature divergence  [feature]
 *                    \-> main advanced after divergence   [main]
 *
 * `merge-base feature main` is the "shared base" commit; `main` has at least
 * one commit past it that `feature` does not contain, and vice versa.
 */
export function buildDivergedRepo(prefix = "git-fixture-diverged-") {
  const { dir, cleanup } = createTempRepo(prefix);

  write(dir, "shared.txt", "shared base content\n");
  runGit(dir, ["add", "shared.txt"]);
  runGit(dir, ["commit", "-q", "-m", "shared base"]);

  runGit(dir, ["branch", "feature"]);
  runGit(dir, ["checkout", "-q", "feature"]);
  write(dir, "feature.txt", "feature divergence content\n");
  runGit(dir, ["add", "feature.txt"]);
  runGit(dir, ["commit", "-q", "-m", "feature divergence"]);

  runGit(dir, ["checkout", "-q", "main"]);
  write(dir, "main-advanced.txt", "main advanced content\n");
  runGit(dir, ["add", "main-advanced.txt"]);
  runGit(dir, ["commit", "-q", "-m", "main advanced after divergence"]);

  runGit(dir, ["checkout", "-q", "feature"]);

  return {
    dir,
    cleanup,
    branches: { base: "main", feature: "feature" },
  };
}
