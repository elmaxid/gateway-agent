/**
 * Tests for the deterministic git fixture helper (tests/helpers/git-fixture.mjs).
 *
 * Every assertion is verified with direct git commands against the fixture
 * repo — the helper's return value is used only to name paths, never to
 * decide pass/fail. This keeps the test honest about what git actually
 * reports for each built state.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

import { buildFixtureRepo, buildDivergedRepo, runGit } from "./helpers/git-fixture.mjs";

/**
 * Parses `git status --porcelain=v1 -z` into a map keyed by path (the
 * post-rename path for renames). Each value is { x, y, path, oldPath }.
 * Renames/copies carry a second NUL-separated field for the source path.
 */
function parsePorcelainZ(output) {
  const entries = {};
  const parts = output.split("\0").filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const x = entry[0];
    const y = entry[1];
    const filePath = entry.slice(3);
    let oldPath = null;
    if (x === "R" || x === "C") {
      oldPath = parts[i + 1];
      i += 1;
    }
    entries[filePath] = { x, y, path: filePath, oldPath };
  }
  return entries;
}

function porcelain(repo) {
  return parsePorcelainZ(runGit(repo, ["status", "--porcelain=v1", "-z"]));
}

function stagedNames(repo) {
  return runGit(repo, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
}

function worktreeNames(repo) {
  return runGit(repo, ["diff", "--name-only"]).split("\n").filter(Boolean);
}

function untrackedNames(repo) {
  return runGit(repo, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
}

function ignoredNames(repo) {
  return runGit(repo, ["ls-files", "--others", "--ignored", "--exclude-standard"]).split("\n").filter(Boolean);
}

function cachedNameStatus(repo) {
  return runGit(repo, ["diff", "--cached", "--name-status"]);
}

function worktreeNameStatus(repo) {
  return runGit(repo, ["diff", "--name-status"]);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("git fixture: working-tree states", () => {
  let repo;
  let manifest;
  let dir;

  before(() => {
    repo = buildFixtureRepo();
    manifest = repo.files;
    dir = repo.dir;
  });

  after(() => {
    if (repo) repo.cleanup();
  });

  it("builds a real git repo on main with the expected base files", () => {
    assert.equal(runGit(dir, ["branch", "--show-current"]).trim(), "main");
    assert.ok(existsSync(path.join(dir, ".gitignore")));
  });

  it("staged file: in index only, not in worktree diff, not untracked", () => {
    const f = manifest.stagedOnly.path;
    const p = porcelain(dir);
    assert.equal(p[f]?.x, "A", `${f} should be added in index`);
    assert.equal(p[f]?.y, " ", `${f} should have a clean worktree`);
    assert.ok(stagedNames(dir).includes(f), `${f} should appear in --cached --name-only`);
    assert.ok(!worktreeNames(dir).includes(f), `${f} should NOT appear in worktree diff`);
    assert.ok(!untrackedNames(dir).includes(f), `${f} should NOT be untracked`);
  });

  it("tracked file modified in worktree but not staged", () => {
    const f = manifest.worktreeModified.path;
    const p = porcelain(dir);
    assert.equal(p[f]?.x, " ", `${f} index should be unchanged`);
    assert.equal(p[f]?.y, "M", `${f} worktree should be modified`);
    assert.ok(worktreeNames(dir).includes(f), `${f} should appear in worktree diff`);
    assert.ok(!stagedNames(dir).includes(f), `${f} should NOT appear in --cached`);
  });

  it("file staged AND modified again (index and worktree differ)", () => {
    const f = manifest.stagedThenModified.path;
    const p = porcelain(dir);
    assert.equal(p[f]?.x, "M", `${f} should be staged-modified in index`);
    assert.equal(p[f]?.y, "M", `${f} should also be modified in worktree`);
    assert.ok(stagedNames(dir).includes(f), `${f} should appear in --cached`);
    assert.ok(worktreeNames(dir).includes(f), `${f} should appear in worktree diff`);
  });

  it("untracked file: reported by ls-files --others, porcelain ??", () => {
    const f = manifest.untracked.path;
    const p = porcelain(dir);
    assert.equal(p[f]?.x, "?", `${f} should be untracked (??)`);
    assert.equal(p[f]?.y, "?", `${f} should be untracked (??)`);
    assert.ok(untrackedNames(dir).includes(f), `${f} should be in --others --exclude-standard`);
    assert.ok(!stagedNames(dir).includes(f), `${f} should NOT be staged`);
    assert.ok(!worktreeNames(dir).includes(f), `${f} should NOT be in tracked worktree diff`);
  });

  it("ignored file: hidden from --others, visible in --ignored", () => {
    const f = manifest.ignored.path;
    assert.ok(!untrackedNames(dir).includes(f), `${f} should be excluded from --others`);
    assert.ok(ignoredNames(dir).includes(f), `${f} should appear in --others --ignored`);
    const p = porcelain(dir);
    assert.ok(!p[f], `${f} should NOT appear in porcelain at all`);
  });

  it("rename with no further edits: pure R100 in --cached", () => {
    const m = manifest.renamePure;
    const p = porcelain(dir);
    assert.equal(p[m.path]?.x, "R", `${m.path} should be a staged rename`);
    assert.equal(p[m.path]?.oldPath, m.oldPath, `rename source should be ${m.oldPath}`);
    const status = cachedNameStatus(dir);
    assert.match(status, new RegExp(`^R100\\t${escapeRegex(m.oldPath)}\\t${escapeRegex(m.path)}$`, "m"));
    assert.ok(!worktreeNames(dir).includes(m.path), `${m.path} should have no worktree diff`);
  });

  it("rename followed by further edits: R<100 in --cached", () => {
    const m = manifest.renameEdit;
    const p = porcelain(dir);
    assert.equal(p[m.path]?.x, "R", `${m.path} should be a staged rename`);
    assert.equal(p[m.path]?.oldPath, m.oldPath, `rename source should be ${m.oldPath}`);
    const status = cachedNameStatus(dir);
    const re = new RegExp(`^R(\\d+)\\t${escapeRegex(m.oldPath)}\\t${escapeRegex(m.path)}$`, "m");
    const match = status.match(re);
    assert.ok(match, `expected a rename entry for ${m.path} in --cached name-status`);
    const score = Number(match[1]);
    assert.ok(score < 100, `rename-with-edit similarity should be < 100, got ${score}`);
  });

  it("deletion staged in the index", () => {
    const f = manifest.deleteStaged.path;
    const p = porcelain(dir);
    assert.equal(p[f]?.x, "D", `${f} should be staged-deleted in index`);
    assert.equal(p[f]?.y, " ", `${f} should have no worktree-side change`);
    const status = cachedNameStatus(dir);
    assert.match(status, new RegExp(`^D\\t${escapeRegex(f)}$`, "m"));
    assert.ok(!existsSync(path.join(dir, f)), `${f} should be gone from the worktree`);
    assert.ok(!worktreeNames(dir).includes(f), `${f} should NOT appear in worktree diff`);
  });

  it("deletion only in the worktree (not staged)", () => {
    const f = manifest.deleteWorktree.path;
    const p = porcelain(dir);
    assert.equal(p[f]?.x, " ", `${f} index should still hold the file`);
    assert.equal(p[f]?.y, "D", `${f} worktree should show deletion`);
    const status = worktreeNameStatus(dir);
    assert.match(status, new RegExp(`^D\\t${escapeRegex(f)}$`, "m"));
    assert.ok(!stagedNames(dir).includes(f), `${f} should NOT appear in --cached`);
    assert.ok(!existsSync(path.join(dir, f)), `${f} should be gone from the worktree`);
  });

  it("path containing spaces: staged and reported verbatim", () => {
    const f = manifest.spacesStaged.path;
    const p = porcelain(dir);
    assert.ok(p[f], `porcelain should contain the spaces path verbatim: ${f}`);
    assert.equal(p[f]?.x, "A", `${f} should be added in index`);
    assert.equal(p[f]?.y, " ", `${f} should have a clean worktree`);
    assert.ok(stagedNames(dir).includes(f), `${f} should appear in --cached --name-only`);
  });
});

describe("git fixture: diverged branch with advanced base", () => {
  it("feature diverged from main, and main advanced past the merge-base", () => {
    const repo = buildDivergedRepo();
    try {
      const { dir } = repo;
      assert.equal(runGit(dir, ["branch", "--show-current"]).trim(), "feature");

      const mergeBase = runGit(dir, ["merge-base", "feature", "main"]).trim();
      const mainHead = runGit(dir, ["rev-parse", "main"]).trim();
      const featureHead = runGit(dir, ["rev-parse", "feature"]).trim();

      assert.notEqual(mergeBase, mainHead, "main must have advanced past the merge-base");
      assert.notEqual(mergeBase, featureHead, "feature must have diverged past the merge-base");
      assert.notEqual(mainHead, featureHead, "main and feature must be at different commits");

      const mainOnly = runGit(dir, ["rev-list", "--count", `${mergeBase}..main`]).trim();
      const featureOnly = runGit(dir, ["rev-list", "--count", `${mergeBase}..feature`]).trim();
      assert.ok(Number(mainOnly) >= 1, `main should have >=1 commit past merge-base, got ${mainOnly}`);
      assert.ok(Number(featureOnly) >= 1, `feature should have >=1 commit past merge-base, got ${featureOnly}`);

      const diffToMain = runGit(dir, ["diff", "--name-only", `${mainHead}..${featureHead}`]).trim();
      assert.ok(diffToMain.length > 0, "feature should diff against advanced main");
    } finally {
      repo.cleanup();
    }
  });

  it("cleanup removes the diverged repo", () => {
    const repo = buildDivergedRepo();
    const { dir } = repo;
    repo.cleanup();
    assert.ok(!existsSync(dir), "cleanup should remove the diverged repo dir");
  });
});
