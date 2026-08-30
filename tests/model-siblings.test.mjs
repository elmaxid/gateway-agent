import { test } from "node:test";
import assert from "node:assert/strict";

import { findSiblingModels } from "../plugins/gateway/scripts/lib/model-siblings.mjs";

const LIVE_MODELS = [
  "kimi-k2.6", "kimi-k2.7-code", "kimi-k2-thinking", "kimi-k3",
  "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-ollama",
  "minimax-m3",
  "glm-5.2", "glm-5.2-ollama", "glm-5.3-flash-ollama",
  "devstral-2:123b", "cogito-2.1:671b",
  "nemotron-3-ultra", "nemotron-3-super", "nemotron-3-nano:30b",
  "gpt-oss:120b", "qwen3.5", "gemma4",
  "glm-5.3", "glm-5.3-zai", "glm-5.3-flash",
  "gemini-flash", "gemini-pro",
  "codex-gpt5", "codex-gpt54", "codex-gpt54-mini", "codex-spark", "codex-gpt56-terra",
];

test("finds other models sharing the same prefix, excluding the configured one", () => {
  const siblings = findSiblingModels("glm-5.2", LIVE_MODELS);
  assert.deepEqual(
    [...siblings].sort(),
    ["glm-5.2-ollama", "glm-5.3", "glm-5.3-flash", "glm-5.3-flash-ollama", "glm-5.3-zai"]
  );
});

test("does not cross into an unrelated family with a similar prefix", () => {
  const siblings = findSiblingModels("codex-gpt5", LIVE_MODELS);
  assert.ok(!siblings.includes("codex-spark"), "codex-spark is a different family, should not match");
  assert.ok(siblings.includes("codex-gpt54"), "codex-gpt54 shares the codex-gpt prefix");
});

test("returns empty when the live model list is empty", () => {
  assert.deepEqual(findSiblingModels("glm-5.2", []), []);
});

test("works even when the configured model itself is not in the live list (e.g. deprecated)", () => {
  const siblings = findSiblingModels("glm-5.1", ["glm-5.2", "glm-5.3"]);
  assert.deepEqual([...siblings].sort(), ["glm-5.2", "glm-5.3"]);
});

test("a model name with no digits matches nothing but itself, so returns empty", () => {
  assert.deepEqual(findSiblingModels("gpt-oss:120b".replace(/\d/g, ""), ["totally-unrelated"]), []);
});
