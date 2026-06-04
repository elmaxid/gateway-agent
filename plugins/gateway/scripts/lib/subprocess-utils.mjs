// Shared subprocess utilities used by claude-subprocess.mjs and codex-harness.mjs.
export { terminateProcessTree } from "./process.mjs";

const ENV_WHITELIST = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "NODE_PATH", "TMPDIR", "TMP", "TEMP"
];

export function pickEnv(source) {
  const picked = {};
  for (const key of ENV_WHITELIST) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  for (const key of Object.keys(source)) {
    if (key.startsWith("XDG_")) picked[key] = source[key];
  }
  return picked;
}
