#!/usr/bin/env node
// ---------------------------------------------------------------------------
// baseline-capture.mjs — standalone pre-upgrade workstation snapshot (v0.5.2
// hotfix plan, Task A1, §4).
//
// HARD CONSTRAINT: this file is copied ALONE to dev workstations that only
// have the gateway plugin INSTALLED (via the Claude Code marketplace cache,
// possibly an OLDER version than this repo) — there is no repo checkout to
// import from. It must therefore:
//   - import nothing but node:* builtins,
//   - not depend on `gateway-companion baseline --json` (that subcommand does
//     not exist on v0.5.1 — it cannot be a prerequisite of its own baseline),
//   - tolerate every capture step failing independently without ever failing
//     to emit its final JSON.
//
// Small pieces of logic already implemented elsewhere in this repo (plugin
// version/commit resolution in plugins/gateway/scripts/lib/version-info.mjs,
// secret redaction in plugins/gateway/scripts/lib/redaction.mjs) are
// deliberately REIMPLEMENTED here rather than imported. That duplication is
// intentional, not a DRY violation — this file must survive being copied
// alone to a machine that has none of those library files.
//
// Usage:
//   node baseline-capture.mjs [--json] [--out file] [--plugin-root path] [--run-matrix]
//
//   --json          Explicit no-op: the only supported output format is JSON
//                   (that's the whole point of this capture). Accepted so the
//                   documented CLI contract has an explicit flag for it.
//   --out file      Write the JSON to `file` instead of stdout.
//   --plugin-root   Pin plugin discovery to exactly this directory instead of
//                   auto-discovering every installation on this workstation.
//   --run-matrix    Additionally smoke-test the real gateway-companion review
//                   and task commands against configured profiles. This
//                   makes real network calls and consumes model tokens.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;
export const DEFAULT_MATRIX_TIMEOUT_MS = 120_000;
export const MATRIX_OUTPUT_MAX_LINES = 20;
const BINARY_PROBE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Redaction (reimplemented standalone — see file header)
// ---------------------------------------------------------------------------

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collect literal apiKey/authToken values out of every profile in a loaded
 * gateway config, so they can be scrubbed verbatim from any captured text.
 * @param {{profiles?: Record<string, object>}} config
 * @returns {string[]} unique, non-empty secret strings
 */
export function collectProfileSecrets(config) {
  const secrets = new Set();
  const profiles = config?.profiles;
  if (profiles && typeof profiles === "object") {
    for (const profile of Object.values(profiles)) {
      if (!profile || typeof profile !== "object") continue;
      for (const key of ["apiKey", "authToken"]) {
        const val = profile[key];
        if (typeof val === "string" && val.length > 0) secrets.add(val);
      }
    }
  }
  return [...secrets];
}

/**
 * Redact sensitive material from a text blob: `Bearer <token>` headers,
 * literal config secrets, credentials embedded in URLs, and URL query
 * strings. Used both for the config summary's baseUrl handling and for
 * --run-matrix stdout/stderr capture.
 * @param {string} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function redactText(text, secrets = []) {
  if (typeof text !== "string" || text.length === 0) return text ?? "";
  let out = text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  const sorted = [...new Set(secrets.filter((s) => typeof s === "string" && s.length > 0))].sort(
    (a, b) => b.length - a.length
  );
  for (const secret of sorted) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g, "$1[REDACTED]@");
  out = out.replace(/\?[^\s#]+/g, "?[REDACTED]");
  return out;
}

/**
 * Bound multi-line text to at most `n` lines, appending a marker recording
 * how many lines were dropped.
 */
export function firstNLines(text, n = MATRIX_OUTPUT_MAX_LINES) {
  if (typeof text !== "string" || text.length === 0) return "";
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  const omitted = lines.length - n;
  return `${lines.slice(0, n).join("\n")}\n[... ${omitted} lines omitted]`;
}

/**
 * Redact then bound matrix stdout/stderr to the first N lines. Pure —
 * exercised directly in tests/baseline-capture.test.mjs.
 */
export function redactMatrixOutput(text, secrets = []) {
  return firstNLines(redactText(text, secrets), MATRIX_OUTPUT_MAX_LINES);
}

/**
 * Sanitize a profile's baseUrl for reporting: if it carries credentials or a
 * query string, reduce it to `scheme://host` only. Otherwise return it
 * unchanged (a bare host/path with no query is not sensitive on its own).
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function sanitizeBaseUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return rawUrl ?? null;
  try {
    const parsed = new URL(rawUrl);
    const hasCreds = Boolean(parsed.username || parsed.password);
    const hasQuery = Boolean(parsed.search) && parsed.search.length > 1;
    if (hasCreds || hasQuery) {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return rawUrl;
  } catch {
    // Not a parseable URL — defensively strip credential/query-shaped text
    // rather than pass through something we couldn't verify is clean.
    return rawUrl
      .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/, "$1")
      .replace(/\?[^\s#]+/, "");
  }
}

// ---------------------------------------------------------------------------
// Plugin discovery + version/commit detection
// ---------------------------------------------------------------------------

/**
 * Resolve {version, commit, commitSource} for a plugin root, mirroring
 * plugins/gateway/scripts/lib/version-info.mjs's resolution order:
 *   1. <pluginRoot>/.claude-plugin/build-info.json → "build-info"
 *   2. `git rev-parse HEAD` with cwd=pluginRoot (dev checkout) → "git"
 *   3. Neither → "unknown"
 * @param {string} pluginRoot
 */
export function getPluginVersionInfo(pluginRoot) {
  const pluginJsonPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  let version = "unknown";
  try {
    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
    if (pluginJson.version) version = pluginJson.version;
  } catch {
    // Missing/unreadable/invalid plugin.json — version stays "unknown".
  }

  let commit = null;
  let commitSource = null;

  const buildInfoPath = path.join(pluginRoot, ".claude-plugin", "build-info.json");
  try {
    const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
    if (buildInfo.commit) {
      commit = buildInfo.commit;
      commitSource = "build-info";
    }
  } catch {
    // No build-info.json — fall through to git.
  }

  if (!commit) {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: pluginRoot, encoding: "utf8" });
    if (result.status === 0 && result.stdout && result.stdout.trim()) {
      commit = result.stdout.trim();
      commitSource = "git";
    }
  }

  if (!commit) {
    commit = "unknown";
    commitSource = "unknown";
  }

  return { version, commit, commitSource };
}

function describeInstallation(pluginRoot, source) {
  return { source, pluginRoot, ...getPluginVersionInfo(pluginRoot) };
}

function hasPluginJson(dir) {
  try {
    return fs.statSync(path.join(dir, ".claude-plugin", "plugin.json")).isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively walk the Claude Code plugin marketplace cache looking for
 * directories whose path contains "gateway" (case-insensitive) and that
 * directly contain a .claude-plugin/plugin.json. Multiple matches are
 * expected and reported as-is (orphaned/stale versions included) — surfacing
 * that ambiguity is the point of this capture.
 * @param {string} cacheRoot
 * @param {number} [maxDepth]
 * @returns {string[]} absolute pluginRoot paths
 */
export function findMarketplaceCacheInstallations(cacheRoot, maxDepth = 8) {
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (full.toLowerCase().includes("gateway") && hasPluginJson(full)) {
        found.push(full);
      }
      walk(full, depth + 1);
    }
  }
  walk(cacheRoot, 0);
  return found;
}

/**
 * Candidate directories for "this script is running from inside a repo
 * checkout" — checked only as a best-effort convenience; on a real
 * workstation (no checkout) these simply won't exist.
 */
function findLocalCheckoutInstallations({ cwd, scriptPath }) {
  const candidates = new Set();
  if (cwd) {
    candidates.add(cwd);
    candidates.add(path.join(cwd, "plugins", "gateway"));
  }
  if (scriptPath) {
    const scriptDir = path.dirname(scriptPath);
    candidates.add(path.join(scriptDir, ".."));
    candidates.add(path.join(scriptDir, "..", "plugins", "gateway"));
  }
  return [...candidates].filter(hasPluginJson);
}

/**
 * Resolve every gateway plugin installation this workstation can see.
 *  - If `explicitPluginRoot` is given, it is the ONLY installation reported
 *    (the operator has told us exactly where to look).
 *  - Otherwise, report every marketplace-cache match plus any local checkout
 *    — deliberately plural, since finding more than one is itself evidence
 *    of the ambiguous-builds problem this capture exists to catch.
 */
export function discoverPluginInstallations({ explicitPluginRoot, cwd, scriptPath, cacheRoot } = {}) {
  if (explicitPluginRoot) {
    return [describeInstallation(path.resolve(explicitPluginRoot), "explicit-flag")];
  }

  const seen = new Map(); // realpath -> installation
  const addCandidate = (pluginRoot, source) => {
    let key;
    try {
      key = fs.realpathSync(pluginRoot);
    } catch {
      key = path.resolve(pluginRoot);
    }
    if (!seen.has(key)) {
      seen.set(key, describeInstallation(pluginRoot, source));
    }
  };

  const resolvedCacheRoot = cacheRoot || path.join(os.homedir(), ".claude", "plugins", "cache");
  for (const dir of findMarketplaceCacheInstallations(resolvedCacheRoot)) {
    addCandidate(dir, "marketplace-cache");
  }
  for (const dir of findLocalCheckoutInstallations({ cwd, scriptPath })) {
    addCandidate(dir, "local-checkout");
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Binary version capture
// ---------------------------------------------------------------------------

/**
 * Run `<cmd> --version` (tolerating absence) and report {found, exitStatus,
 * firstLine}. `found` is false only when the executable could not be
 * located at all (ENOENT) — a nonzero exit still counts as found.
 */
export function captureBinaryVersion(cmd, args = ["--version"], { timeoutMs = BINARY_PROBE_TIMEOUT_MS } = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  if (result.error && result.error.code === "ENOENT") {
    return { found: false, exitStatus: null, firstLine: null };
  }
  const text = (result.stdout && result.stdout.trim()) || (result.stderr && result.stderr.trim()) || "";
  const firstLine = text.split("\n")[0]?.trim() || null;
  return {
    found: true,
    exitStatus: typeof result.status === "number" ? result.status : null,
    firstLine,
  };
}

export function captureAllBinaries() {
  return {
    node: captureBinaryVersion("node", ["--version"]),
    claude: captureBinaryVersion("claude", ["--version"]),
    codex: captureBinaryVersion("codex", ["--version"]),
    zero: captureBinaryVersion("zero", ["--version"]),
  };
}

// ---------------------------------------------------------------------------
// Config capture (SIN SECRETOS)
// ---------------------------------------------------------------------------

export function resolveConfigPath() {
  const dir = process.env.GATEWAY_PLUGIN_CONFIG_DIR || path.join(os.homedir(), ".gateway-plugin");
  return path.join(dir, "config.json");
}

/**
 * Load the gateway config for reporting purposes only. Never throws: a
 * missing file is "not found" (not an error); a corrupt file is reported via
 * `error` with empty profiles.
 */
export function loadConfigSafely(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return { config, found: true, error: null };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { config: { profiles: {}, defaultProfile: null, reviewProfile: null, taskProfile: null }, found: false, error: null };
    }
    return { config: { profiles: {}, defaultProfile: null, reviewProfile: null, taskProfile: null }, found: true, error: err.message };
  }
}

/**
 * Build the redacted, boolean-only summary for a single profile. Never
 * includes the literal apiKey/authToken value.
 */
export function buildProfileSummary(name, profile, { gatewayApiKeyEnvPresent }) {
  return {
    name,
    kind: profile?.kind ?? null,
    model: profile?.defaultModel ?? profile?.model ?? null,
    baseUrl: sanitizeBaseUrl(profile?.baseUrl ?? null),
    hasApiKey: typeof profile?.apiKey === "string" && profile.apiKey.length > 0,
    hasAuthToken: typeof profile?.authToken === "string" && profile.authToken.length > 0,
    hasGatewayApiKeyEnv: gatewayApiKeyEnvPresent,
  };
}

/**
 * Build the full config section of the capture: sanitized profiles, roles,
 * and the config path/found/error metadata. Pure given its inputs — tested
 * directly for secret leakage.
 */
export function buildConfigSection({ config, configPath, found, error, gatewayApiKeyEnvPresent }) {
  const profiles = config?.profiles && typeof config.profiles === "object" ? config.profiles : {};
  return {
    configPath,
    found: Boolean(found),
    error: error ?? null,
    roles: {
      defaultProfile: config?.defaultProfile ?? null,
      reviewProfile: config?.reviewProfile ?? null,
      taskProfile: config?.taskProfile ?? null,
    },
    profiles: Object.entries(profiles).map(([name, profile]) =>
      buildProfileSummary(name, profile, { gatewayApiKeyEnvPresent })
    ),
  };
}

export function captureConfig() {
  const configPath = resolveConfigPath();
  const { config, found, error } = loadConfigSafely(configPath);
  const gatewayApiKeyEnvPresent = Boolean(process.env.GATEWAY_API_KEY);
  return {
    section: buildConfigSection({ config, configPath, found, error, gatewayApiKeyEnvPresent }),
    rawConfig: config,
  };
}

// ---------------------------------------------------------------------------
// Environment capture
// ---------------------------------------------------------------------------

export function captureEnvironment() {
  return {
    os: os.type(),
    platform: process.platform,
    arch: process.arch,
    hasHttpProxy: Boolean(process.env.HTTP_PROXY),
    hasHttpsProxy: Boolean(process.env.HTTPS_PROXY),
    hasNoProxy: Boolean(process.env.NO_PROXY),
  };
}

// ---------------------------------------------------------------------------
// --run-matrix: real gateway-companion smoke tests
// ---------------------------------------------------------------------------

/**
 * Resolve how to invoke gateway-companion: prefer the `gateway-companion` bin
 * on PATH (package.json registers it there); fall back to
 * `node <pluginRoot>/scripts/gateway-companion.mjs` when a pluginRoot with
 * that script is known. Returns null if neither is available.
 */
export function resolveGatewayInvocation({ pluginRoot } = {}) {
  const probe = spawnSync("gateway-companion", ["--help"], { encoding: "utf8", timeout: BINARY_PROBE_TIMEOUT_MS });
  if (!(probe.error && probe.error.code === "ENOENT")) {
    return { cmd: "gateway-companion", baseArgs: [] };
  }
  if (pluginRoot) {
    const scriptPath = path.join(pluginRoot, "scripts", "gateway-companion.mjs");
    if (fs.existsSync(scriptPath)) {
      return { cmd: process.execPath, baseArgs: [scriptPath] };
    }
  }
  return null;
}

function createSyntheticReviewFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-review-fixture-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "baseline-capture@example.invalid"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "baseline-capture"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "baseline-capture synthetic fixture"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello world\n");
  return dir;
}

/**
 * Run one matrix operation with a hard timeout so a hung workstation can
 * never block the overall capture. Never throws — spawn errors and timeouts
 * are captured in the result, not propagated.
 */
function runMatrixOperation({ cmd, args, cwd, timeoutMs, secrets }) {
  const commandLabel = [cmd, ...args].join(" ");
  const start = Date.now();
  let result;
  try {
    result = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    return {
      command: commandLabel,
      skipped: false,
      exitStatus: null,
      signal: null,
      timedOut: false,
      durationMs: Date.now() - start,
      stdout: "",
      stderr: redactMatrixOutput(err instanceof Error ? err.message : String(err), secrets),
    };
  }
  const timedOut = result.signal !== null && result.signal !== undefined && result.status === null;
  return {
    command: commandLabel,
    skipped: false,
    exitStatus: typeof result.status === "number" ? result.status : null,
    signal: result.signal ?? null,
    timedOut,
    durationMs: Date.now() - start,
    stdout: redactMatrixOutput(result.stdout ?? "", secrets),
    stderr: redactMatrixOutput(result.stderr ?? "", secrets),
  };
}

/**
 * Run the full §4.2 matrix: a direct review smoke test (only if a
 * reviewProfile is configured) plus four task invocations (implicit,
 * --harness codex, --harness zero, --harness claude). Always returns a
 * result object — never throws, never hangs past timeoutMs per operation.
 */
export function runMatrix({ config, secrets, timeoutMs = DEFAULT_MATRIX_TIMEOUT_MS, gatewayCommand }) {
  if (!gatewayCommand) {
    return {
      enabled: true,
      gatewayCommand: null,
      operations: [
        {
          name: "review",
          command: null,
          skipped: true,
          skipReason: "no gateway-companion command found (not on PATH, and no local pluginRoot script)",
        },
        ...["task", "task --harness codex", "task --harness zero", "task --harness claude"].map((name) => ({
          name,
          command: null,
          skipped: true,
          skipReason: "no gateway-companion command found (not on PATH, and no local pluginRoot script)",
        })),
      ],
    };
  }

  const { cmd, baseArgs } = gatewayCommand;
  const operations = [];

  if (config?.reviewProfile) {
    let fixtureDir = null;
    try {
      fixtureDir = createSyntheticReviewFixture();
      operations.push({
        name: "review",
        ...runMatrixOperation({
          cmd,
          args: [...baseArgs, "review", "--profile", config.reviewProfile, "--scope", "working-tree", "--cwd", fixtureDir],
          cwd: process.cwd(),
          timeoutMs,
          secrets,
        }),
      });
    } catch (err) {
      operations.push({
        name: "review",
        command: null,
        skipped: true,
        skipReason: `failed to set up synthetic review fixture: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      if (fixtureDir) {
        try {
          fs.rmSync(fixtureDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
  } else {
    operations.push({
      name: "review",
      command: null,
      skipped: true,
      skipReason: "no reviewProfile configured",
    });
  }

  const taskVariants = [
    { name: "task", extraArgs: [] },
    { name: "task --harness codex", extraArgs: ["--harness", "codex"] },
    { name: "task --harness zero", extraArgs: ["--harness", "zero"] },
    { name: "task --harness claude", extraArgs: ["--harness", "claude"] },
  ];
  for (const variant of taskVariants) {
    operations.push({
      name: variant.name,
      ...runMatrixOperation({
        cmd,
        args: [...baseArgs, "task", ...variant.extraArgs, "reply OK"],
        cwd: process.cwd(),
        timeoutMs,
        secrets,
      }),
    });
  }

  return { enabled: true, gatewayCommand: { cmd, baseArgs }, operations };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function safeSection(label, fn) {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[baseline-capture] Warning: ${label} capture failed: ${message}\n`);
    return { error: message };
  }
}

export function buildCapture({ cwd, scriptPath, explicitPluginRoot, runMatrix: shouldRunMatrix } = {}) {
  const installations = safeSection("plugin", () =>
    discoverPluginInstallations({ explicitPluginRoot, cwd, scriptPath })
  );
  const binaries = safeSection("binaries", () => captureAllBinaries());
  const { section: configSection, rawConfig } = safeSection("config", () => captureConfig()) ?? {
    section: { error: "config capture failed" },
    rawConfig: {},
  };
  const environment = safeSection("environment", () => captureEnvironment());

  let matrix = { enabled: false };
  if (shouldRunMatrix) {
    matrix = safeSection("matrix", () => {
      const secrets = collectProfileSecrets(rawConfig);
      const primaryRoot = Array.isArray(installations) && installations[0] ? installations[0].pluginRoot : null;
      const gatewayCommand = resolveGatewayInvocation({ pluginRoot: primaryRoot });
      return runMatrix({ config: rawConfig, secrets, gatewayCommand });
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    plugin: { installations },
    binaries,
    config: configSection,
    environment,
    matrix,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseCliArgs(argv) {
  const args = { json: false, out: null, pluginRoot: null, runMatrix: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--json":
        args.json = true;
        break;
      case "--run-matrix":
        args.runMatrix = true;
        break;
      case "--out":
        i += 1;
        if (argv[i] === undefined) throw new Error("Missing value for --out");
        args.out = argv[i];
        break;
      case "--plugin-root":
        i += 1;
        if (argv[i] === undefined) throw new Error("Missing value for --plugin-root");
        args.pluginRoot = argv[i];
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.runMatrix) {
    process.stderr.write(
      "[baseline-capture] --run-matrix invokes real gateway-companion review/task commands against configured " +
        "profiles. This makes real network calls and consumes model tokens.\n"
    );
  }

  const capture = buildCapture({
    cwd: process.cwd(),
    scriptPath: fileURLToPath(import.meta.url),
    explicitPluginRoot: args.pluginRoot,
    runMatrix: args.runMatrix,
  });

  const json = JSON.stringify(capture, null, 2);
  if (args.out) {
    fs.writeFileSync(args.out, json + "\n");
    process.stdout.write(`[baseline-capture] Wrote baseline to ${args.out}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[baseline-capture] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
