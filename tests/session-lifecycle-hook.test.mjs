import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, "../plugins/gateway/scripts/session-lifecycle-hook.mjs");

function runHook(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [HOOK, "SessionStart"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Hook exited ${code}: ${stderr}`));
      else resolve();
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

describe("session-lifecycle-hook", () => {
  let tmpDir;
  let envFile;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-hook-test-"));
    envFile = path.join(tmpDir, "claude.env");
    fs.writeFileSync(envFile, "");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes GATEWAY_TRANSCRIPT_PATH to CLAUDE_ENV_FILE on SessionStart", async () => {
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-123",
      transcript_path: "/root/.claude/projects/foo/bar.jsonl"
    });

    await runHook(input, {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      GATEWAY_PLUGIN_CONFIG_DIR: tmpDir
    });

    const written = fs.readFileSync(envFile, "utf8");
    assert.ok(
      written.includes("GATEWAY_TRANSCRIPT_PATH"),
      `Expected GATEWAY_TRANSCRIPT_PATH in env file, got:\n${written}`
    );
    assert.ok(
      written.includes("/root/.claude/projects/foo/bar.jsonl"),
      `Expected transcript path value in env file, got:\n${written}`
    );
  });

  it("does not write GATEWAY_TRANSCRIPT_PATH when transcript_path is absent", async () => {
    const cleanEnvFile = path.join(tmpDir, "claude-no-transcript.env");
    fs.writeFileSync(cleanEnvFile, "");

    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "test-session-456"
      // no transcript_path
    });

    await runHook(input, {
      ...process.env,
      CLAUDE_ENV_FILE: cleanEnvFile,
      GATEWAY_PLUGIN_CONFIG_DIR: tmpDir
    });

    const written = fs.readFileSync(cleanEnvFile, "utf8");
    assert.ok(
      !written.includes("GATEWAY_TRANSCRIPT_PATH"),
      `Expected no GATEWAY_TRANSCRIPT_PATH in env file when path absent, got:\n${written}`
    );
  });
});
