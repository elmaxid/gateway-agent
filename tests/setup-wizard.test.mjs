/**
 * `setup wizard` — interactive model picker: browse a source profile's
 * /v1/models, pick several by number, name+kind each one, choose a default.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const COMPANION = path.join(REPO_ROOT, "plugins/gateway/scripts/gateway-companion.mjs");

const MODEL_IDS = ["model-a", "model-b", "codex-model-c"];

let server;
let baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function mkConfigDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-setup-wizard-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function readConfig(configDir) {
  return JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
}

function baseConfig() {
  return {
    profiles: {
      src: { kind: "claude-gateway", baseUrl, defaultModel: "model-a", authToken: "authtok123" }
    },
    defaultProfile: "src",
    reviewProfile: null,
    taskProfile: null
  };
}

function runWizard(args, { configDir, answers }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMPANION, "setup", "wizard", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, GATEWAY_PLUGIN_CONFIG_DIR: configDir }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(answers.map((a) => `${a}\n`).join(""));
    child.stdin.end();
  });
}

describe("setup wizard", () => {
  it("adds selected models with inherited baseUrl/authToken, honoring the codex- kind heuristic, and sets the chosen default", async () => {
    const configDir = mkConfigDir(baseConfig());
    const { code, stdout } = await runWizard(["--source", "src"], {
      configDir,
      answers: [
        "2,3",   // model-b, codex-model-c (model-a is index 1, already configured)
        "",      // profile name for model-b -> default "model-b"
        "",      // kind for model-b -> default "claude-gateway"
        "",      // profile name for codex-model-c -> default "model-c" (codex- prefix stripped)
        "",      // kind for codex-model-c -> default "openai-chat"
        "model-b" // default profile
      ]
    });

    assert.equal(code, 0, stdout);
    assert.match(stdout, /Added 2 profile\(s\): model-b, model-c/);

    const config = readConfig(configDir);
    assert.deepEqual(config.profiles["model-b"], {
      kind: "claude-gateway",
      baseUrl,
      defaultModel: "model-b",
      authToken: "authtok123"
    });
    assert.deepEqual(config.profiles["model-c"], {
      kind: "openai-chat",
      baseUrl,
      defaultModel: "codex-model-c",
      authToken: "authtok123"
    });
    assert.equal(config.defaultProfile, "model-b");
    // original profile untouched
    assert.equal(config.profiles.src.defaultModel, "model-a");
  });

  it("skips already-configured models and out-of-range indices, and leaves config untouched on empty selection", async () => {
    const configDir = mkConfigDir(baseConfig());
    const before = readConfig(configDir);

    const { code, stdout, stderr } = await runWizard(["--source", "src"], {
      configDir,
      answers: [""] // Enter with no selection -> cancel
    });

    assert.equal(code, 0, stderr);
    assert.match(stdout, /Nothing selected, no changes\./);
    assert.deepEqual(readConfig(configDir), before);
  });

  it("re-prompts on a profile-name collision until a free name is given", async () => {
    const configDir = mkConfigDir(baseConfig());
    const { code, stdout, stderr } = await runWizard(["--source", "src"], {
      configDir,
      answers: [
        "2",        // model-b
        "src",      // collides with existing profile -> re-prompt
        "model-b2", // accepted
        "",         // kind default
        ""          // default-profile prompt -> keep current
      ]
    });

    assert.equal(code, 0, stderr);
    assert.match(stderr, /"src" already exists\./);
    const config = readConfig(configDir);
    assert.equal(config.profiles["model-b2"].defaultModel, "model-b");
    assert.equal(config.profiles.src.defaultModel, "model-a");
  });
});
