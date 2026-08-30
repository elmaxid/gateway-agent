/**
 * `setup doctor` — best-effort "other models available" note for the
 * default/review/task profiles, so a stale configured model (e.g. glm-5.2
 * when glm-5.3/glm-5.3-flash already exist) doesn't silently go unnoticed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(__dirname, "../plugins/gateway/scripts/gateway-companion.mjs");
const EXEC_TIMEOUT_MS = 30000;

function mkTmpConfigDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-doctor-siblings-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
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
    return err.stdout ?? "";
  }
}

function startFakeGateway({ models, modelsStatus = 200 }) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "test-model", choices: [{ message: { content: "hi" } }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      if (modelsStatus !== 200) {
        res.writeHead(modelsStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function baseUrlOf(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

describe("setup doctor -- other-models-available note for role profiles", () => {
  it("text output notes sibling models for the default/review/task profile", async () => {
    const server = await startFakeGateway({ models: ["glm-5.2", "glm-5.3", "glm-5.3-flash"] });
    const configDir = mkTmpConfigDir({
      profiles: { glm: { kind: "claude-gateway", baseUrl: baseUrlOf(server), defaultModel: "glm-5.2", authToken: "tok" } },
      defaultProfile: "glm", reviewProfile: "glm", taskProfile: "glm",
    });
    try {
      const stdout = await runDoctor([], configDir);
      assert.match(
        stdout,
        /default → glm.*other models available for glm: glm-5\.3, glm-5\.3-flash.*setup set-model --profile glm --model <name>/s,
        `Expected a sibling-models note on the default role line, got:\n${stdout}`
      );
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("--json exposes otherModelsAvailable on the profile entry", async () => {
    const server = await startFakeGateway({ models: ["glm-5.2", "glm-5.3", "glm-5.3-flash"] });
    const configDir = mkTmpConfigDir({
      profiles: { glm: { kind: "claude-gateway", baseUrl: baseUrlOf(server), defaultModel: "glm-5.2", authToken: "tok" } },
      defaultProfile: "glm", reviewProfile: null, taskProfile: null,
    });
    try {
      const stdout = await runDoctor(["--json"], configDir);
      const parsed = JSON.parse(stdout);
      assert.deepEqual(parsed.profiles.glm.otherModelsAvailable, ["glm-5.3", "glm-5.3-flash"]);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("prints no note when the configured model has no siblings in the live catalog", async () => {
    const server = await startFakeGateway({ models: ["solo-only"] });
    const configDir = mkTmpConfigDir({
      profiles: { solo: { kind: "claude-gateway", baseUrl: baseUrlOf(server), defaultModel: "solo-only", authToken: "tok" } },
      defaultProfile: "solo", reviewProfile: null, taskProfile: null,
    });
    try {
      const stdout = await runDoctor([], configDir);
      assert.doesNotMatch(stdout, /other models available/, `Expected no sibling note, got:\n${stdout}`);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("does not fail doctor when the live models call errors — best-effort only", async () => {
    const server = await startFakeGateway({ models: [], modelsStatus: 500 });
    const configDir = mkTmpConfigDir({
      profiles: { glm: { kind: "claude-gateway", baseUrl: baseUrlOf(server), defaultModel: "glm-5.2", authToken: "tok" } },
      defaultProfile: "glm", reviewProfile: null, taskProfile: null,
    });
    try {
      const stdout = await runDoctor([], configDir);
      assert.match(stdout, /default → glm/, `Expected doctor to still report the role, got:\n${stdout}`);
      assert.doesNotMatch(stdout, /other models available/);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
