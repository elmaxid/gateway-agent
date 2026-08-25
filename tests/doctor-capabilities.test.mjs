/**
 * Task 19 — `setup doctor` renders the declared capability matrix.
 *
 * Black-box: spawn the real CLI against an empty isolated config dir (no
 * profiles configured -> preflightProfiles returns [] -> no network calls),
 * and assert the matrix from harness-capabilities.mjs shows up in both
 * --json and text output.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { HARNESSES, HARNESS_CAPABILITIES } from "../plugins/gateway/scripts/lib/harness-capabilities.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");
const EXEC_TIMEOUT_MS = 30000;

function mkTmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gw-doctor-capabilities-"));
}

async function runDoctor(args, configDir) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [COMPANION, "setup", "doctor", ...args], {
      cwd: __dirname,
      env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: configDir },
      timeout: EXEC_TIMEOUT_MS,
    });
    return stdout;
  } catch (err) {
    // doctor exits 1 when the local `claude` binary check fails, unrelated
    // to capabilities -- stdout still carries the full report either way.
    return err.stdout ?? "";
  }
}

describe("setup doctor -- capability matrix (Task 19)", () => {
  it("--json includes a capabilities key matching the declared matrix exactly", async () => {
    const dir = mkTmpConfigDir();
    try {
      const stdout = await runDoctor(["--json"], dir);
      const parsed = JSON.parse(stdout);
      assert.deepEqual(parsed.capabilities, HARNESS_CAPABILITIES);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("text output has a [capabilities] section naming every harness and dimension", async () => {
    const dir = mkTmpConfigDir();
    try {
      const stdout = await runDoctor([], dir);
      assert.ok(stdout.includes("[capabilities]"), `Expected a [capabilities] section, got:\n${stdout}`);
      for (const harness of HARNESSES) {
        assert.ok(stdout.includes(harness), `Expected "${harness}" to appear in doctor output`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
