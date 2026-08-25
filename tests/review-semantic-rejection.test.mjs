/**
 * Task 12 — Semantic rejection of `review` arguments.
 *
 * Black-box CLI tests: spawn the real gateway-companion.mjs binary. Both
 * checks live at the top of handleReview, before any config/git/network
 * access — an isolated empty config dir is enough, no repo fixture needed.
 *
 *   1. `review` takes no positionals — it has no free-text use, unlike
 *      adversarial-review [focus] and staged-review [intent]. A stray
 *      positional errors, naming both real alternatives.
 *   2. `--include-diff` without `--no-tools` errors: the default agentic
 *      route never reads it (the model collects its own context via tools),
 *      so the flag would otherwise be a silent no-op.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");
const EXEC_TIMEOUT_MS = 8000;

function mkTmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gw-review-semantic-"));
}

async function runCli(args, configDir) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [COMPANION, ...args], {
      cwd: __dirname,
      env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: configDir },
      timeout: EXEC_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("review rejects positionals", () => {
  it("errors naming both real alternatives", async () => {
    const configDir = mkTmpConfigDir();
    try {
      const result = await runCli(["review", "fix the bug"], configDir);
      assert.notEqual(result.code, 0);
      assert.equal(result.code, 2, `expected exit 2 (usage error), got ${result.code}; stderr: ${result.stderr}`);
      assert.ok(result.stderr.includes("adversarial-review"), `stderr should name adversarial-review: ${result.stderr}`);
      assert.ok(result.stderr.includes("staged-review"), `stderr should name staged-review: ${result.stderr}`);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("does not reject a bare review with no positionals for this reason", async () => {
    const configDir = mkTmpConfigDir();
    try {
      const result = await runCli(["review"], configDir);
      // No profile configured in the isolated dir — fails later, for an
      // unrelated reason. The point: it must not be OUR positionals message.
      assert.ok(!result.stderr.includes("does not take free text"), `unexpected positionals rejection: ${result.stderr}`);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("review rejects --include-diff without --no-tools", () => {
  it("errors explaining the mode", async () => {
    const configDir = mkTmpConfigDir();
    try {
      const result = await runCli(["review", "--include-diff"], configDir);
      assert.notEqual(result.code, 0);
      assert.equal(result.code, 2, `expected exit 2 (usage error), got ${result.code}; stderr: ${result.stderr}`);
      assert.ok(result.stderr.includes("--no-tools"), `stderr should explain the --no-tools requirement: ${result.stderr}`);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("does not reject --include-diff together with --no-tools for this reason", async () => {
    const configDir = mkTmpConfigDir();
    try {
      const result = await runCli(["review", "--include-diff", "--no-tools"], configDir);
      // No profile configured — fails later, for an unrelated reason. The
      // point: it must not be OUR --include-diff/--no-tools message.
      assert.ok(!result.stderr.includes("has no effect without --no-tools"), `unexpected include-diff rejection: ${result.stderr}`);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("does not reject --no-tools alone (without --include-diff) for this reason", async () => {
    const configDir = mkTmpConfigDir();
    try {
      const result = await runCli(["review", "--no-tools"], configDir);
      assert.ok(!result.stderr.includes("has no effect without --no-tools"), `unexpected include-diff rejection: ${result.stderr}`);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
