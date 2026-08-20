import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildTargetInventory,
  collectReviewContext,
  resolveReviewTarget,
} from "../plugins/gateway/scripts/lib/git.mjs";
import { buildDivergedRepo, buildFixtureRepo, runGit } from "./helpers/git-fixture.mjs";

describe("canonical target inventory: working-tree fixture", () => {
  it("records index and worktree state separately per path, with renames and untracked", () => {
    const repo = buildFixtureRepo("git-inventory-state-");
    try {
      const target = resolveReviewTarget(repo.dir);
      assert.equal(target.mode, "working-tree");

      const inventory = buildTargetInventory(repo.dir, target);
      assert.deepEqual(inventory, [
        { path: "committed-modified.txt", index: null, worktree: "M", renameFrom: null, untracked: false },
        { path: "committed-staged-then-modified.txt", index: "M", worktree: "M", renameFrom: null, untracked: false },
        { path: "delete-staged.txt", index: "D", worktree: null, renameFrom: null, untracked: false },
        { path: "delete-worktree.txt", index: null, worktree: "D", renameFrom: null, untracked: false },
        { path: "path with spaces/spaces-staged.txt", index: "A", worktree: null, renameFrom: null, untracked: false },
        { path: "rename-edit-new.txt", index: "R", worktree: null, renameFrom: "rename-edit-old.txt", untracked: false },
        { path: "rename-pure-new.txt", index: "R", worktree: null, renameFrom: "rename-pure-old.txt", untracked: false },
        { path: "staged-only.txt", index: "A", worktree: null, renameFrom: null, untracked: false },
        { path: "untracked.txt", index: null, worktree: null, renameFrom: null, untracked: true },
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it("derives the same changed-file set as the direct collector", () => {
    const repo = buildFixtureRepo("git-inventory-parity-");
    try {
      const target = resolveReviewTarget(repo.dir);
      const inventory = buildTargetInventory(repo.dir, target);
      const direct = collectReviewContext(repo.dir, target, {
        includeDiff: true,
      });

      // Hardcoded, not compared against each other: the collector derives changedFiles by
      // mapping this same inventory, so asserting one against the other could only fail on
      // non-determinism. Pinning the literal list is what actually guards the data.
      const expectedPaths = [
        "committed-modified.txt",
        "committed-staged-then-modified.txt",
        "delete-staged.txt",
        "delete-worktree.txt",
        "path with spaces/spaces-staged.txt",
        "rename-edit-new.txt",
        "rename-pure-new.txt",
        "staged-only.txt",
        "untracked.txt",
      ];
      assert.deepEqual(inventory.map((entry) => entry.path), expectedPaths);
      assert.deepEqual(direct.changedFiles, expectedPaths);
    } finally {
      repo.cleanup();
    }
  });
});

describe("canonical target inventory: diverged branch fixture", () => {
  it("carries immutable merge-base and reviewed-head identifiers", () => {
    const repo = buildDivergedRepo("git-inventory-branch-");
    try {
      const target = resolveReviewTarget(repo.dir);
      assert.equal(target.mode, "branch");
      assert.equal(target.baseRef, "main");
      assert.equal(target.mergeBase, runGit(repo.dir, ["merge-base", "HEAD", "main"]).trim());
      assert.equal(target.headCommit, runGit(repo.dir, ["rev-parse", "HEAD"]).trim());
    } finally {
      repo.cleanup();
    }
  });

  it("matches the direct collector for a base that advanced after divergence", () => {
    const repo = buildDivergedRepo("git-inventory-branch-parity-");
    try {
      const target = resolveReviewTarget(repo.dir);
      const inventory = buildTargetInventory(repo.dir, target);
      const direct = collectReviewContext(repo.dir, target);

      assert.deepEqual(inventory, [
        { path: "feature.txt", index: "A", worktree: null, renameFrom: null, untracked: false },
      ]);
      assert.deepEqual(
        inventory.map((entry) => entry.path),
        direct.changedFiles
      );
      assert.deepEqual(direct.changedFiles, ["feature.txt"]);
    } finally {
      repo.cleanup();
    }
  });
});

describe("git inventory: branch-mode renames", () => {
  it("reports a rename committed on the branch as one entry carrying both paths", () => {
    const repo = buildDivergedRepo("git-inventory-branch-rename-");
    try {
      // buildDivergedRepo leaves us on `feature`. Commit a rename there so the branch range
      // contains one — the fixture otherwise only adds files, which is why the forced
      // --find-renames in buildBranchInventory went untested when it landed.
      runGit(repo.dir, ["mv", "shared.txt", "shared-renamed.txt"]);
      runGit(repo.dir, ["commit", "-q", "-m", "rename shared"]);

      const target = resolveReviewTarget(repo.dir, { scope: "branch" });
      const inventory = buildTargetInventory(repo.dir, target);
      const rename = inventory.find((entry) => entry.path === "shared-renamed.txt");

      // One entry, not an add plus a delete: branch mode passes --find-renames explicitly, so
      // this holds regardless of the ambient diff.renames setting. The working-tree side does
      // NOT force it and stays config-dependent — that asymmetry is deliberate and recorded
      // in git.mjs, not an oversight.
      assert.ok(rename, `expected a renamed entry, got ${JSON.stringify(inventory)}`);
      assert.equal(rename.renameFrom, "shared.txt");
      assert.ok(
        !inventory.some((entry) => entry.path === "shared.txt"),
        "the rename source must not also appear as a separate deleted entry"
      );
    } finally {
      repo.cleanup();
    }
  });
});
