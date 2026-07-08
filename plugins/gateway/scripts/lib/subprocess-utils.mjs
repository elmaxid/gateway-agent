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

// A profile is user-controlled config, but a profile shared from an untrusted
// source (docs, a colleague, a support thread) shouldn't be able to hijack the
// subprocess via env. Strip keys that affect process loading/execution.
const DANGEROUS_SUBPROCESS_ENV_KEYS = [
  "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
  "NODE_OPTIONS", "PYTHONPATH", "PERL5LIB", "BASH_ENV", "ENV", "IFS",
];

export function sanitizeSubprocessEnv(subprocessEnv) {
  if (!subprocessEnv) return subprocessEnv;
  const safe = { ...subprocessEnv };
  for (const key of DANGEROUS_SUBPROCESS_ENV_KEYS) delete safe[key];
  return safe;
}
