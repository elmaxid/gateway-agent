import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  collectReviewContext,
  getWorkingTreeState,
  resolveReviewTarget,
} from "../plugins/gateway/scripts/lib/git.mjs";
import {
  captureTreeFingerprintForTest,
  dispatchToolForTest,
} from "../plugins/gateway/scripts/lib/agentic-review.mjs";
import {
  buildDivergedRepo,
  buildFixtureRepo,
  createTempRepo,
  runGit,
} from "./helpers/git-fixture.mjs";

const REDUCED_GUIDANCE =
  "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";

function sectionBody(content, title) {
  const marker = `## ${title}\n\n`;
  const start = content.indexOf(marker);
  assert.notEqual(start, -1, `expected section ${title}`);
  const bodyStart = start + marker.length;
  const nextSection = content.indexOf("\n## ", bodyStart);
  return content.slice(bodyStart, nextSection === -1 ? undefined : nextSection).trimEnd();
}

function diffHeaders(content) {
  return content.split("\n").filter((line) => line.startsWith("diff --git "));
}

function buildThreeStateRepo() {
  const repo = createTempRepo("git-context-three-state-");
  writeFileSync(path.join(repo.dir, "tracked.txt"), "base\n");
  runGit(repo.dir, ["add", "tracked.txt"]);
  runGit(repo.dir, ["commit", "-q", "-m", "base"]);
  writeFileSync(path.join(repo.dir, "staged.txt"), "staged\n");
  runGit(repo.dir, ["add", "staged.txt"]);
  writeFileSync(path.join(repo.dir, "tracked.txt"), "modified\n");
  writeFileSync(path.join(repo.dir, "untracked.txt"), "untracked\n");
  return repo;
}

describe("git context characterization: comprehensive working tree fixture", () => {
  it("records target selection and all three working-tree categories", () => {
    const repo = buildFixtureRepo("git-context-state-");
    try {
      assert.deepEqual(getWorkingTreeState(repo.dir), {
        staged: [
          "committed-staged-then-modified.txt",
          "delete-staged.txt",
          "path with spaces/spaces-staged.txt",
          "rename-edit-new.txt",
          "rename-pure-new.txt",
          "staged-only.txt",
        ],
        unstaged: [
          "committed-modified.txt",
          "committed-staged-then-modified.txt",
          "delete-worktree.txt",
        ],
        untracked: ["untracked.txt"],
        isDirty: true,
      });
      assert.deepEqual(resolveReviewTarget(repo.dir), {
        mode: "working-tree",
        label: "working tree diff",
        explicit: false,
      });
      assert.deepEqual(resolveReviewTarget(repo.dir, { scope: "working-tree" }), {
        mode: "working-tree",
        label: "working tree diff",
        explicit: true,
      });
    } finally {
      repo.cleanup();
    }
  });

  it("records inline and threshold-reduced collector output", () => {
    const repo = buildFixtureRepo("git-context-collector-");
    try {
      const target = resolveReviewTarget(repo.dir);
      const expectedChangedFiles = [
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
      const expectedStatus = [
        "M committed-modified.txt",
        "MM committed-staged-then-modified.txt",
        "D  delete-staged.txt",
        " D delete-worktree.txt",
        "A  \"path with spaces/spaces-staged.txt\"",
        "R  rename-edit-old.txt -> rename-edit-new.txt",
        "R  rename-pure-old.txt -> rename-pure-new.txt",
        "A  staged-only.txt",
        "?? untracked.txt",
      ].join("\n");

      const inline = collectReviewContext(repo.dir, target, { includeDiff: true });
      assert.equal(inline.cwd, repo.dir);
      assert.equal(inline.repoRoot, repo.dir);
      assert.equal(inline.branch, "main");
      assert.deepEqual(inline.target, target);
      assert.equal(inline.mode, "working-tree");
      assert.equal(inline.fileCount, 9);
      assert.equal(inline.diffBytes, 1970);
      assert.equal(inline.summary, "Reviewing 6 staged, 3 unstaged, and 1 untracked file(s).");
      assert.deepEqual(inline.changedFiles, expectedChangedFiles);
      assert.equal(sectionBody(inline.content, "Git Status"), expectedStatus);
      assert.deepEqual(diffHeaders(sectionBody(inline.content, "Staged Diff")), [
        "diff --git a/committed-staged-then-modified.txt b/committed-staged-then-modified.txt",
        "diff --git a/delete-staged.txt b/delete-staged.txt",
        "diff --git a/path with spaces/spaces-staged.txt b/path with spaces/spaces-staged.txt",
        "diff --git a/rename-edit-old.txt b/rename-edit-new.txt",
        "diff --git a/rename-pure-old.txt b/rename-pure-new.txt",
        "diff --git a/staged-only.txt b/staged-only.txt",
      ]);
      assert.deepEqual(diffHeaders(sectionBody(inline.content, "Unstaged Diff")), [
        "diff --git a/committed-modified.txt b/committed-modified.txt",
        "diff --git a/committed-staged-then-modified.txt b/committed-staged-then-modified.txt",
        "diff --git a/delete-worktree.txt b/delete-worktree.txt",
      ]);
      assert.equal(sectionBody(inline.content, "Untracked Files"), "### untracked.txt\n```\nuntracked\n```");

      // Task 5 converted this: the collector used to return a stats-only context here, with a
      // "self-collect" marker nobody read. A tool-less model cannot self-collect, so it now
      // refuses instead of presenting partial evidence as a normal review.
      assert.throws(
        () => collectReviewContext(repo.dir, target, { maxInlineFiles: 0, maxInlineDiffBytes: 0 }),
        /cannot produce a complete review without the diff/
      );
    } finally {
      repo.cleanup();
    }
  });

  it("records the current agentic inventory and diff views", async () => {
    const repo = buildFixtureRepo("git-context-agentic-");
    try {
      const target = resolveReviewTarget(repo.dir);

      // Task 4 converted this: the agentic inventory is now the canonical review-target inventory,
      // with index and worktree state visible, renames showing both paths, and untracked marked.
      assert.equal(
        await dispatchToolForTest("list_changed_files", {}, repo.dir, repo.dir, target),
        " M\tcommitted-modified.txt\n" +
          "MM\tcommitted-staged-then-modified.txt\n" +
          "D \tdelete-staged.txt\n" +
          " D\tdelete-worktree.txt\n" +
          "A \tpath with spaces/spaces-staged.txt\n" +
          "R \trename-edit-old.txt -> rename-edit-new.txt\n" +
          "R \trename-pure-old.txt -> rename-pure-new.txt\n" +
          "A \tstaged-only.txt\n" +
          "??\tuntracked.txt\n"
      );

      // Task 4 converted this: the diff now covers staged and unstaged target changes; untracked
      // files are listed in the inventory and read with read_file, not diffed.
      assert.deepEqual(diffHeaders(await dispatchToolForTest("git_diff", {}, repo.dir, repo.dir, target)), [
        "diff --git a/committed-staged-then-modified.txt b/committed-staged-then-modified.txt",
        "diff --git a/delete-staged.txt b/delete-staged.txt",
        "diff --git a/path with spaces/spaces-staged.txt b/path with spaces/spaces-staged.txt",
        "diff --git a/rename-edit-old.txt b/rename-edit-new.txt",
        "diff --git a/rename-pure-old.txt b/rename-pure-new.txt",
        "diff --git a/staged-only.txt b/staged-only.txt",
        "diff --git a/committed-modified.txt b/committed-modified.txt",
        "diff --git a/committed-staged-then-modified.txt b/committed-staged-then-modified.txt",
        "diff --git a/delete-worktree.txt b/delete-worktree.txt",
      ]);
    } finally {
      repo.cleanup();
    }
  });
});

describe("git context characterization: diverged branch fixture", () => {
  it("records clean-tree target selection and both collector variants", () => {
    const repo = buildDivergedRepo("git-context-branch-");
    try {
      assert.deepEqual(getWorkingTreeState(repo.dir), {
        staged: [],
        unstaged: [],
        untracked: [],
        isDirty: false,
      });

      // Branch-target shape is pinned in tests/git-inventory.test.mjs, which owns it. It is
      // deliberately absent here: this file is the pre-Task-3 snapshot and never described the
      // immutable identifiers, so asserting them here would fake a baseline that never existed.
      const target = resolveReviewTarget(repo.dir);

      // Still derived here because the collector assertions below reference it; what was removed
      // is the assertion on the target's own shape, not this value.
      const mergeBase = runGit(repo.dir, ["merge-base", "HEAD", "main"]).trim();
      const shortHead = runGit(repo.dir, ["rev-parse", "--short", "HEAD"]).trim();
      const expectedComparison = {
        mergeBase,
        commitRange: `${mergeBase}..HEAD`,
        reviewRange: "main...HEAD",
      };

      const inline = collectReviewContext(repo.dir, target);
      assert.equal(inline.branch, "feature");
      assert.equal(inline.mode, "branch");
      assert.equal(inline.fileCount, 1);
      assert.equal(inline.diffBytes, 157);
      assert.equal(inline.summary, `Reviewing branch feature against main from merge-base ${mergeBase}.`);
      assert.deepEqual(inline.changedFiles, ["feature.txt"]);
      assert.deepEqual(inline.comparison, expectedComparison);
      assert.equal(sectionBody(inline.content, "Commit Log"), `${shortHead} (HEAD -> feature) feature divergence`);
      assert.equal(sectionBody(inline.content, "Diff Stat"), "feature.txt | 1 +\n 1 file changed, 1 insertion(+)");
      assert.deepEqual(diffHeaders(sectionBody(inline.content, "Branch Diff")), [
        "diff --git a/feature.txt b/feature.txt",
      ]);

      // Task 5 converted this: branch mode refuses the same way working-tree mode does, rather
      // than shipping a stats-only context to a model that has no way to fetch the rest.
      assert.throws(
        () => collectReviewContext(repo.dir, target, { maxInlineFiles: 0, maxInlineDiffBytes: 0 }),
        /cannot produce a complete review without the diff/
      );
    } finally {
      repo.cleanup();
    }
  });

  it("records the agentic branch range discrepancy", async () => {
    const repo = buildDivergedRepo("git-context-branch-agentic-");
    try {
      const target = resolveReviewTarget(repo.dir);

      // Task 4 converted this: the tool is tied to the resolved merge-base target instead of the
      // broken base..HEAD range, so the spurious deletion of main-advanced.txt is gone.
      assert.equal(
        await dispatchToolForTest("list_changed_files", {}, repo.dir, repo.dir, target),
        "A \tfeature.txt\n"
      );

      // Task 4 converted this: the diff is the resolved merge-base..head range, not main..HEAD.
      assert.deepEqual(
        diffHeaders(await dispatchToolForTest("git_diff", {}, repo.dir, repo.dir, target)),
        [
          "diff --git a/feature.txt b/feature.txt",
        ]
      );
    } finally {
      repo.cleanup();
    }
  });
});

describe("git context characterization: central working-tree discrepancy", () => {
  it("pins direct collection of three states against the agentic tool's single state", async () => {
    const repo = buildThreeStateRepo();
    try {
      const target = resolveReviewTarget(repo.dir);
      const direct = collectReviewContext(repo.dir, target, { includeDiff: true });

      assert.deepEqual(direct.changedFiles, ["staged.txt", "tracked.txt", "untracked.txt"]);
      assert.equal(direct.summary, "Reviewing 1 staged, 1 unstaged, and 1 untracked file(s).");

      // Task 4 closed this defect: the agentic inventory now sees all three files, matching the
      // direct collector, with index/worktree state and the untracked marker visible.
      assert.equal(
        await dispatchToolForTest("list_changed_files", {}, repo.dir, repo.dir, target),
        "A \tstaged.txt\n M\ttracked.txt\n??\tuntracked.txt\n"
      );

      // Task 4 closed the matching diff defect: staged.txt is now in the diff alongside
      // tracked.txt; untracked.txt is read with read_file, not diffed.
      assert.deepEqual(
        diffHeaders(await dispatchToolForTest("git_diff", {}, repo.dir, repo.dir, target)),
        [
          "diff --git a/staged.txt b/staged.txt",
          "diff --git a/tracked.txt b/tracked.txt",
        ]
      );
    } finally {
      repo.cleanup();
    }
  });
});

describe("git context characterization: mid-review working-tree mutation", () => {
  it("invalidates the review when the working tree changes after the target is resolved", async () => {
    const repo = buildThreeStateRepo();
    try {
      const target = resolveReviewTarget(repo.dir);
      const fingerprint = await captureTreeFingerprintForTest(repo.dir);

      // Before mutation the inventory is correct — this is the baseline, not an inventory bug.
      assert.equal(
        await dispatchToolForTest("list_changed_files", {}, repo.dir, repo.dir, target, fingerprint),
        "A \tstaged.txt\n M\ttracked.txt\n??\tuntracked.txt\n"
      );

      // Mutate the tree mid-review: a new untracked file appears.
      writeFileSync(path.join(repo.dir, "late.txt"), "late\n");

      // The tool now refuses instead of returning a silently-stale inventory.
      assert.match(
        await dispatchToolForTest("list_changed_files", {}, repo.dir, repo.dir, target, fingerprint),
        /working tree changed during the review/
      );
    } finally {
      repo.cleanup();
    }
  });

  it("invalidates the review when an untracked file's content changes", async () => {
    // The narrow case the first test misses: no file appears or disappears, so the status codes
    // are identical and neither diff covers the bytes. The model was told to read this file with
    // read_file, so a stale read here is worse than for a tracked file, not better.
    const repo = buildThreeStateRepo();
    try {
      const target = resolveReviewTarget(repo.dir);
      const fingerprint = await captureTreeFingerprintForTest(repo.dir);

      assert.equal(
        await dispatchToolForTest("list_changed_files", {}, repo.dir, repo.dir, target, fingerprint),
        "A \tstaged.txt\n M\ttracked.txt\n??\tuntracked.txt\n"
      );

      writeFileSync(path.join(repo.dir, "untracked.txt"), "rewritten after the model read it\n");

      assert.match(
        await dispatchToolForTest("list_changed_files", {}, repo.dir, repo.dir, target, fingerprint),
        /working tree changed during the review/
      );
    } finally {
      repo.cleanup();
    }
  });
});
