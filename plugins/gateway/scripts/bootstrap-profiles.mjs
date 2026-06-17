#!/usr/bin/env node
/**
 * Bootstrap gateway profiles on a new machine.
 *
 * Usage:
 *   node bootstrap-profiles.mjs --url URL --api-key KEY
 *   GATEWAY_URL=http://... GATEWAY_API_KEY=sk-... node bootstrap-profiles.mjs
 *
 * Creates 9 profiles covering all use cases:
 *
 *   minimax       → minimax-m3            (default + task — análisis, síntesis)
 *   deepseek-pro  → deepseek-v4-pro       (review — razonamiento profundo)
 *   deepseek-flash→ deepseek-v4-flash     (iteración rápida)
 *   glm           → glm-5.2              (coding, research — large context)
 *   nemotron      → nemotron-3-ultra      (seguridad, razonamiento)
 *   kimi-think    → kimi-k2-thinking      (debug, análisis profundo)
 *   kimi-code     → kimi-k2.6            (coding)
 *   devstral      → devstral-2:123b       (coding especializado)
 *   cogito        → cogito-2.1:671b       (debate, seguridad, adversarial)
 *   gemini-flash  → gemini-flash          (iteración rápida, bajo costo)
 *   gemini-pro    → gemini-pro            (razonamiento general, largo contexto)
 *
 * Sets: defaultProfile=minimax, reviewProfile=deepseek-pro, taskProfile=minimax
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

const PROFILES = [
  { name: "minimax",       defaultModel: "minimax-m3" },
  { name: "deepseek-pro",  defaultModel: "deepseek-v4-pro" },
  { name: "deepseek-flash",defaultModel: "deepseek-v4-flash" },
  { name: "glm",           defaultModel: "glm-5.2" },
  { name: "nemotron",      defaultModel: "nemotron-3-ultra" },
  { name: "kimi-think",    defaultModel: "kimi-k2-thinking" },
  { name: "kimi-code",     defaultModel: "kimi-k2.6" },
  { name: "devstral",      defaultModel: "devstral-2:123b" },
  { name: "cogito",        defaultModel: "cogito-2.1:671b" },
  { name: "gemini-flash",  defaultModel: "gemini-flash" },
  { name: "gemini-pro",    defaultModel: "gemini-pro" },
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

config.defaultProfile = "minimax";
config.reviewProfile = "deepseek-pro";
config.taskProfile = "minimax";

saveConfig(config);

console.log(`\nConfig saved → ${CONFIG_PATH}`);
console.log(`  defaultProfile : minimax`);
console.log(`  reviewProfile  : deepseek-pro`);
console.log(`  taskProfile    : minimax`);
console.log(`\nVerify with: node gateway-companion.mjs setup list`);
