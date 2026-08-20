import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { collectReviewContext, resolveReviewTarget } from "../plugins/gateway/scripts/lib/git.mjs";
import { createTempRepo, runGit } from "./helpers/git-fixture.mjs";

/**
 * Contract 2 — Ninguna revisión con evidencia incompleta se presenta como completa.
 *
 * The direct review route has no tools: the model sees only what the collector
 * injects.  When the change exceeds the inline thresholds and the caller did
 * not explicitly force the diff with --include-diff, the collector MUST fail
 * before returning — it must never hand back a stats-only context that would
 * be presented as a complete review.
 *
 * This file exercises the contract for both target modes (working-tree and
 * branch) and for every way the threshold can be crossed: too many files, too
 * many bytes, and an explicit --include-diff:false.
 */

describe("Contract 2: direct route evidence contract", () => {
  describe("working-tree mode", () => {
    it("throws when the file count exceeds the inline threshold", () => {
      const repo = createTempRepo("evidence-wt-files-");
      try {
        // Three files — the default threshold is 2.
        for (const name of ["a.txt", "b.txt", "c.txt"]) {
          writeFileSync(path.join(repo.dir, name), `${name} content\n`);
          runGit(repo.dir, ["add", name]);
        }
        const target = resolveReviewTarget(repo.dir, { scope: "working-tree" });

        assert.throws(
          () => collectReviewContext(repo.dir, target),
          (err) => {
            assert.match(err.message, /direct review route cannot produce a complete review/);
            assert.match(err.message, /--include-diff/);
            assert.match(err.message, /agentic review route/);
            assert.match(err.message, /3 file\(s\)/);
            return true;
          }
        );
      } finally {
        repo.cleanup();
      }
    });

    it("throws when the diff byte count exceeds the inline threshold", () => {
      const repo = createTempRepo("evidence-wt-bytes-");
      try {
        // One file (under the file-count threshold) but large enough to exceed
        // a tight byte limit.
        writeFileSync(path.join(repo.dir, "big.txt"), "x".repeat(500) + "\n");
        runGit(repo.dir, ["add", "big.txt"]);
        const target = resolveReviewTarget(repo.dir, { scope: "working-tree" });

        assert.throws(
          () => collectReviewContext(repo.dir, target, { maxInlineDiffBytes: 64 }),
          (err) => {
            assert.match(err.message, /direct review route cannot produce a complete review/);
            assert.match(err.message, /byte\(s\) of diff/);
            return true;
          }
        );
      } finally {
        repo.cleanup();
      }
    });

    it("throws when includeDiff is explicitly false", () => {
      const repo = createTempRepo("evidence-wt-false-");
      try {
        writeFileSync(path.join(repo.dir, "one.txt"), "one\n");
        runGit(repo.dir, ["add", "one.txt"]);
        const target = resolveReviewTarget(repo.dir, { scope: "working-tree" });

        assert.throws(
          () => collectReviewContext(repo.dir, target, { includeDiff: false }),
          (err) => {
            assert.match(err.message, /direct review route cannot produce a complete review/);
            return true;
          }
        );
      } finally {
        repo.cleanup();
      }
    });

    it("succeeds when includeDiff is explicitly true regardless of size", () => {
      const repo = createTempRepo("evidence-wt-forced-");
      try {
        // Exceeds both thresholds, but --include-diff forces the full diff.
        for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
          writeFileSync(path.join(repo.dir, name), `${name} content\n`);
          runGit(repo.dir, ["add", name]);
        }
        const target = resolveReviewTarget(repo.dir, { scope: "working-tree" });

        const context = collectReviewContext(repo.dir, target, { includeDiff: true });
        assert.equal(context.fileCount, 4);
        assert.ok(context.content.includes("diff --git"));
        // Dead fields are gone.
        assert.equal(context.inputMode, undefined);
        assert.equal(context.collectionGuidance, undefined);
      } finally {
        repo.cleanup();
      }
    });

    it("succeeds with auto-detect when the change is within thresholds", () => {
      const repo = createTempRepo("evidence-wt-small-");
      try {
        writeFileSync(path.join(repo.dir, "small.txt"), "small change\n");
        runGit(repo.dir, ["add", "small.txt"]);
        const target = resolveReviewTarget(repo.dir, { scope: "working-tree" });

        const context = collectReviewContext(repo.dir, target);
        assert.equal(context.fileCount, 1);
        assert.ok(context.content.includes("diff --git"));
        assert.equal(context.inputMode, undefined);
        assert.equal(context.collectionGuidance, undefined);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("branch mode", () => {
    it("throws when the branch diff exceeds the file threshold", () => {
      const repo = createTempRepo("evidence-br-files-");
      try {
        runGit(repo.dir, ["checkout", "-q", "-b", "feature"]);
        for (const name of ["a.txt", "b.txt", "c.txt"]) {
          writeFileSync(path.join(repo.dir, name), `${name}\n`);
          runGit(repo.dir, ["add", name]);
        }
        runGit(repo.dir, ["commit", "-q", "-m", "feature changes"]);
        const target = resolveReviewTarget(repo.dir, { base: "main" });

        assert.throws(
          () => collectReviewContext(repo.dir, target),
          (err) => {
            assert.match(err.message, /direct review route cannot produce a complete review/);
            assert.match(err.message, /--include-diff/);
            assert.match(err.message, /agentic review route/);
            return true;
          }
        );
      } finally {
        repo.cleanup();
      }
    });

    it("throws when the branch diff exceeds the byte threshold", () => {
      const repo = createTempRepo("evidence-br-bytes-");
      try {
        runGit(repo.dir, ["checkout", "-q", "-b", "feature"]);
        writeFileSync(path.join(repo.dir, "big.txt"), "x".repeat(500) + "\n");
        runGit(repo.dir, ["add", "big.txt"]);
        runGit(repo.dir, ["commit", "-q", "-m", "big change"]);
        const target = resolveReviewTarget(repo.dir, { base: "main" });

        assert.throws(
          () => collectReviewContext(repo.dir, target, { maxInlineDiffBytes: 64 }),
          (err) => {
            assert.match(err.message, /direct review route cannot produce a complete review/);
            assert.match(err.message, /byte\(s\) of diff/);
            return true;
          }
        );
      } finally {
        repo.cleanup();
      }
    });

    it("succeeds when includeDiff is explicitly true for a large branch diff", () => {
      const repo = createTempRepo("evidence-br-forced-");
      try {
        runGit(repo.dir, ["checkout", "-q", "-b", "feature"]);
        for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
          writeFileSync(path.join(repo.dir, name), `${name} content\n`);
          runGit(repo.dir, ["add", name]);
        }
        runGit(repo.dir, ["commit", "-q", "-m", "feature changes"]);
        const target = resolveReviewTarget(repo.dir, { base: "main" });

        const context = collectReviewContext(repo.dir, target, { includeDiff: true });
        assert.equal(context.fileCount, 4);
        assert.ok(context.content.includes("diff --git"));
        assert.equal(context.inputMode, undefined);
        assert.equal(context.collectionGuidance, undefined);
      } finally {
        repo.cleanup();
      }
    });

    it("succeeds with auto-detect when the branch diff is within thresholds", () => {
      const repo = createTempRepo("evidence-br-small-");
      try {
        runGit(repo.dir, ["checkout", "-q", "-b", "feature"]);
        writeFileSync(path.join(repo.dir, "small.txt"), "small change\n");
        runGit(repo.dir, ["add", "small.txt"]);
        runGit(repo.dir, ["commit", "-q", "-m", "small change"]);
        const target = resolveReviewTarget(repo.dir, { base: "main" });

        const context = collectReviewContext(repo.dir, target);
        assert.equal(context.fileCount, 1);
        assert.ok(context.content.includes("diff --git"));
        assert.equal(context.inputMode, undefined);
        assert.equal(context.collectionGuidance, undefined);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("error message contract", () => {
    it("names both recovery routes", () => {
      const repo = createTempRepo("evidence-msg-");
      try {
        for (const name of ["a.txt", "b.txt", "c.txt"]) {
          writeFileSync(path.join(repo.dir, name), `${name}\n`);
          runGit(repo.dir, ["add", name]);
        }
        const target = resolveReviewTarget(repo.dir, { scope: "working-tree" });

        try {
          collectReviewContext(repo.dir, target);
          assert.fail("should have thrown");
        } catch (err) {
          assert.match(err.message, /--include-diff/);
          assert.match(err.message, /gateway-companion review/);
          assert.match(err.message, /--no-tools/);
          assert.match(err.message, /read-only tools/);
        }
      } finally {
        repo.cleanup();
      }
    });
  });
});
