import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = process.env.GATEWAY_PLUGIN_CONFIG_DIR || path.join(os.homedir(), ".gateway-plugin");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG = { profiles: {}, defaultProfile: null, reviewProfile: null, taskProfile: null };

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    console.error(`[gateway] Warning: config file is corrupt or unreadable (${CONFIG_PATH}): ${err.message}`);
    console.error(`[gateway] Delete it and run setup again: rm "${CONFIG_PATH}"`);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function resolveProfile(name, config) {
  const cfg = config || loadConfig();
  const key = name || cfg.defaultProfile;
  if (!key || !cfg.profiles[key]) {
    throw new Error(`Profile "${key || "(none)"}" not found. Run /gateway:setup to configure.`);
  }
  return { name: key, ...cfg.profiles[key] };
}

export function resolveReviewProfile(config) {
  const cfg = config || loadConfig();
  return resolveProfile(cfg.reviewProfile || cfg.defaultProfile, cfg);
}

export function resolveTaskProfile(config) {
  const cfg = config || loadConfig();
  const profile = resolveProfile(cfg.taskProfile || cfg.defaultProfile, cfg);
  if (profile.kind !== "claude-gateway") {
    throw new Error(`Task profile "${profile.name}" has kind "${profile.kind}" — requires kind "claude-gateway".`);
  }
  return profile;
}

export function addProfile(config, name, profile) {
  return { ...config, profiles: { ...config.profiles, [name]: profile } };
}

export function removeProfile(config, name) {
  const { [name]: _, ...rest } = config.profiles;
  const updated = { ...config, profiles: rest };
  if (updated.defaultProfile === name) updated.defaultProfile = null;
  if (updated.reviewProfile === name) updated.reviewProfile = null;
  if (updated.taskProfile === name) updated.taskProfile = null;
  return updated;
}

export function listProfiles(config) {
  return Object.entries(config.profiles).map(([name, p]) => ({ name, ...p }));
}

export function validateProfile(profile) {
  const errors = [];
  if (!["claude-gateway", "openai-chat"].includes(profile.kind)) {
    errors.push(`Invalid kind "${profile.kind}". Must be "claude-gateway" or "openai-chat".`);
  }
  if (!profile.baseUrl) {
    errors.push("baseUrl is required.");
  } else {
    let parsed;
    try {
      parsed = new URL(profile.baseUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      errors.push(`baseUrl must be a valid http:// or https:// URL with a host (got "${profile.baseUrl}").`);
    }
  }
  if (!profile.defaultModel) errors.push("defaultModel is required.");
  return { valid: errors.length === 0, errors };
}
