#!/usr/bin/env node
/**
 * Bootstrap gateway profiles on a new machine.
 *
 * Usage:
 *   node bootstrap-profiles.mjs --url URL --api-key KEY
 *   GATEWAY_URL=http://... GATEWAY_API_KEY=sk-... node bootstrap-profiles.mjs
 *
 * Creates the 2 profiles that default/review/task routing actually uses:
 *
 *   glm           → glm-5.3-flash        (default + task — coding, research)
 *   deepseek-pro  → deepseek-v4-pro       (review — razonamiento profundo)
 *
 * A profile is a connection (baseUrl/kind/credentials) plus a default model —
 * not a "specialty." Specialty/behavior comes from `--as <persona>` at call
 * time, and any one-off different model is `--model <name>` on the same
 * profile — neither needs a dedicated named profile. Add more profiles only
 * when a feature actually requires a second distinct participant identity
 * (`/gateway:debate --models a,b`, `dispatch --cross-review`) — via
 * `setup wizard` or `setup add`, not by hardcoding them here.
 *
 * Sets: defaultProfile=glm, reviewProfile=deepseek-pro, taskProfile=glm
 */

import { loadConfig, saveConfig, addProfile, CONFIG_PATH } from "./lib/config.mjs";

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) result.url = argv[++i];
    else if (argv[i] === "--api-key" && argv[i + 1]) result.apiKey = argv[++i];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const url = args.url || process.env.GATEWAY_URL;
const apiKey = args.apiKey || process.env.GATEWAY_API_KEY;

if (!url || !apiKey) {
  console.error("Usage: node bootstrap-profiles.mjs --url URL --api-key KEY");
  console.error("       GATEWAY_URL=http://... GATEWAY_API_KEY=sk-... node bootstrap-profiles.mjs");
  process.exit(1);
}

if (args.apiKey) {
  console.error("[gateway] Warning: --api-key is visible in process listings (ps, /proc/<pid>/cmdline) for the life of this command. Prefer GATEWAY_API_KEY=... instead.");
}

const PROFILES = [
  { name: "glm",          defaultModel: "glm-5.3-flash" },
  { name: "deepseek-pro", defaultModel: "deepseek-v4-pro" },
];

let config = loadConfig();

for (const p of PROFILES) {
  config = addProfile(config, p.name, {
    kind: "claude-gateway",
    baseUrl: url,
    defaultModel: p.defaultModel,
    authToken: apiKey,
  });
  console.log(`  + ${p.name} → ${p.defaultModel}`);
}

config.defaultProfile = "glm";
config.reviewProfile = "deepseek-pro";
config.taskProfile = "glm";

saveConfig(config);

console.log(`\nConfig saved → ${CONFIG_PATH}`);
console.log(`  defaultProfile : glm`);
console.log(`  reviewProfile  : deepseek-pro`);
console.log(`  taskProfile    : glm`);
console.log(`\nVerify with: node gateway-companion.mjs setup list`);
