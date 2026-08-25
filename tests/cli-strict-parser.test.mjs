/**
 * Task 11 — CLI parser must reject unrecognized options.
 *
 * Black-box CLI tests: spawn the real gateway-companion.mjs binary with a
 * clearly-bogus flag (`--totally-bogus-flag-xyz`) for every subcommand family
 * and assert it exits non-zero with the bogus flag named on stderr. The
 * unknown-option error fires inside parseArgs/parseCommandInput, BEFORE any
 * config or network access, so each test uses an isolated empty temp config
 * dir (GATEWAY_PLUGIN_CONFIG_DIR) and a short exec timeout — nothing here
 * should ever reach the network.
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
const BOGUS = "--totally-bogus-flag-xyz";
const EXEC_TIMEOUT_MS = 8000;

function mkTmpConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-strict-parser-"));
  return dir;
}

/**
 * Spawns gateway-companion.mjs with the given argv against an isolated empty
 * config dir. Never throws — captures a non-zero exit as a normal result.
 */
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

function assertRejected(result, label) {
  assert.notEqual(result.code, 0, `[${label}] expected non-zero exit, got ${result.code}; stderr: ${result.stderr}`);
  assert.ok(
    result.stderr.includes("totally-bogus-flag-xyz"),
    `[${label}] expected stderr to name the bogus flag; got: ${result.stderr}`
  );
}

// ---------------------------------------------------------------------------
// Top-level subcommands (setup dispatched by sub-action — handled below)
// ---------------------------------------------------------------------------

describe("CLI rejects unknown options — top-level subcommands", () => {
  const cases = [
    ["review", ["review"]],
    ["adversarial-review", ["adversarial-review"]],
    ["staged-review", ["staged-review"]],
    ["dispatch", ["dispatch", "--task", "do:profile"]],
    ["task", ["task"]],
    ["task-worker", ["task-worker"]],
    ["debate", ["debate"]],
    ["transfer", ["transfer"]],
    ["status", ["status"]],
    ["result", ["result"]],
    ["cancel", ["cancel"]],
    ["version", ["version"]],
  ];

  for (const [label, baseArgs] of cases) {
    it(`rejects unknown flag on \`${label}\``, async () => {
      const configDir = mkTmpConfigDir();
      try {
        const result = await runCli([...baseArgs, BOGUS], configDir);
        assertRejected(result, label);
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// setup sub-actions (dispatched by sub-action first, then parseArgs(rest))
// ---------------------------------------------------------------------------

describe("CLI rejects unknown options — setup sub-actions", () => {
  const subActions = [
    "add",
    "remove",
    "list",
    "test",
    "set-default",
    "set-review-profile",
    "set-task-profile",
    "set-model",
    "doctor",
    "models",
    "wizard",
    "zero-init",
  ];

  for (const action of subActions) {
    it(`rejects unknown flag on \`setup ${action}\``, async () => {
      const configDir = mkTmpConfigDir();
      try {
        const result = await runCli(["setup", action, BOGUS], configDir);
        assertRejected(result, `setup ${action}`);
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    });
  }
});
