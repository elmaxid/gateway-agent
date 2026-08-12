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

// Shared by kimi-harness.mjs and cline-harness.mjs: both read a globally
// configured, externally-authored base_url (kimi's config.toml, cline's
// providers.json) that — like any OpenAI-SDK client convention — carries a
// "/v1" suffix, while this repo's profile.baseUrl never does. An exact-path
// match (like zero-harness's urlsMatch) would report every real profile as
// misaligned. Accept only an empty path or exactly "/v1" on the external
// tool's side (never on the profile side), so a tool repointed at a
// different path on the same host:port (e.g. a different tenant/route)
// still fails preflight instead of silently passing.
export function sameOriginAllowingV1(externalBaseUrl, profileBaseUrl) {
  try {
    const eu = new URL(externalBaseUrl);
    const pu = new URL(profileBaseUrl);
    const port = (u) => u.port || (u.protocol === "https:" ? "443" : "80");
    const externalPath = eu.pathname.replace(/\/+$/, "");
    const profilePath = pu.pathname.replace(/\/+$/, "");
    return eu.protocol === pu.protocol
      && eu.hostname.toLowerCase() === pu.hostname.toLowerCase()
      && port(eu) === port(pu)
      && profilePath === ""
      && (externalPath === "" || externalPath === "/v1");
  } catch {
    return false;
  }
}

// Origin only (protocol+host+port) — never echo a config-derived URL
// verbatim into an agent-visible error message. Values read from an
// external tool's own config are operator-authored today (no
// userinfo/query token observed in practice), but nothing prevents one
// from carrying credentials, and these messages reach the unredacted
// live-progress stream (gateway-companion.mjs runForegroundCommand keeps
// that stream byte-identical by design) — so strip anything beyond origin
// defensively, at zero cost.
export function originOnly(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "(unparseable URL)";
  }
}
