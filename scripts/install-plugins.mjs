#!/usr/bin/env node
// install-plugins.mjs — idempotent global installer for the gateway-plugin-cc
// plugin(s), one command for both a first install and a post-`git pull`
// update.
//
// Why this exists: both harness CLIs (Claude Code, Codex) cache the plugin
// by version at install time. A `git pull` alone does NOT refresh that
// cache — the marketplace registration and the plugin install have to be
// re-run by hand, which is exactly the drift this script closes. See
// docs/superpowers/specs/2026-07-25-harness-installer-design.md (§2.1) and
// docs/superpowers/plans/2026-07-25-harness-installer.md for the full
// design/plan this file implements incrementally.
//
// It detects which harness CLIs are present on this machine and installs or
// updates the matching plugin for each one, in the version actually checked
// out here. It never touches gateway profiles or credentials — that's
// plugins/gateway/scripts/bootstrap-profiles.mjs, out of scope for this file.
//
// Usage:
//   node scripts/install-plugins.mjs             # install/update everything detected
//   node scripts/install-plugins.mjs --dry-run   # print the plan, mutate nothing
//   node scripts/install-plugins.mjs --help      # full flag reference
//
// Implementation status: fully wired end to end — CLI argument parsing
// (`parseCliArgs`, `--help` text — Task 1), manifest reading + version
// drift detection (`readRepoManifests` — Task 2), harness detection +
// state parsing (`detectHarnesses`, `parseClaudeState`, `parseCodexState`
// — Task 3), pure per-harness install/update/uninstall planning
// (`planClaude`, `planCodex`, `validateForceSelection` — Task 4), the
// Codex `--force` cachebuster (`bumpCachebuster`, `applyCachebuster`,
// `hasDevCachebuster` — Task 5), and execution/reporting/exit codes
// (`executePlan`, `renderReport`, `buildJson`, `computeExitCode`, and
// `main()`'s full pipeline — Task 6).
//
// Style precedent: same pattern as scripts/make-build-info.mjs and
// scripts/baseline-capture.mjs — ESM, node:* builtins only, and a main()
// guarded by comparing process.argv[1] against this module's URL so the
// file is importable from tests without side effects.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { captureBinaryVersion, firstNLines, MATRIX_OUTPUT_MAX_LINES } from "./baseline-capture.mjs";

// zero is deliberately excluded: it has no plugin of its own (its setup is
// a credentials step, `gateway-companion setup zero-init`), so it is never
// a valid --harness value and is never detected by this installer.
export const VALID_HARNESSES = ["claude", "codex"];

export const HELP_TEXT = `Usage: node scripts/install-plugins.mjs [options]

Installs or updates the gateway-plugin-cc plugin for every harness CLI
detected on this machine (claude, codex). Same command for a first install
and for re-syncing after a git pull — harness plugin caches are per-version
and a pull alone does not refresh them.

Options:
  -g, --global            No-op. The only install scope this tool supports
                          is user/global; the flag exists so the CLI has an
                          explicit slot for --scope if one is ever added.
  --harness <name>        Restrict to one or more harnesses: claude, codex.
                          Repeatable and/or comma-separated
                          (--harness claude,codex or --harness claude
                          --harness codex). Default: every harness detected
                          on this machine. Naming a harness that isn't
                          present is an error, not a silent skip.
  --dry-run               Print the exact plan (including literal argv) and
                          run zero mutating commands.
  --uninstall             Uninstall the plugin from each selected harness.
                          Does not touch the registered marketplace.
  --purge-marketplace     Also remove the registered marketplace entry.
                          Requires --uninstall.
  --force                 Codex only: bump the codex plugin manifest's
                          cachebuster before reinstalling, so a same-version
                          content change is actually picked up. Errors if
                          the effective --harness selection excludes codex,
                          or if combined with --uninstall.
  --json                  Emit JSON on stdout instead of human-readable text.
  -h, --help              Show this help and exit.

Notes:
  - zero has no plugin of its own and is never detected by this installer;
    its setup is a credentials step, not a plugin install:
      node plugins/gateway/scripts/gateway-companion.mjs setup zero-init
  - Gateway profiles and credentials (URLs, API keys) are configured
    separately and are never read or written by this installer:
      node plugins/gateway/scripts/bootstrap-profiles.mjs --help
`;

/**
 * Parse argv into the installer's CLI options.
 *
 * Throws a plain Error with an actionable message for: an unknown flag, a
 * flag missing its required value, an invalid --harness name,
 * --purge-marketplace without --uninstall, --force combined with
 * --uninstall, and --force when an *explicit* --harness selection excludes
 * codex (--force only has meaning for codex — see the design doc §5).
 *
 * Note on --force with the default selection: passing --force with no
 * --harness at all (harnesses stays null, meaning "every harness detected")
 * is NOT rejected here. Whether codex ends up part of that default
 * selection is only knowable after harness detection, which is added in a
 * later task — rejecting it now would require guessing.
 *
 * @param {string[]} argv
 * @returns {{
 *   global: boolean,
 *   harnesses: string[]|null,
 *   dryRun: boolean,
 *   uninstall: boolean,
 *   purgeMarketplace: boolean,
 *   force: boolean,
 *   json: boolean,
 *   help: boolean,
 * }}
 */
export function parseCliArgs(argv) {
  const args = {
    global: false,
    harnesses: null,
    dryRun: false,
    uninstall: false,
    purgeMarketplace: false,
    force: false,
    json: false,
    help: false,
  };

  const harnessSet = new Set();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "-g":
      case "--global":
        args.global = true;
        break;

      case "--harness": {
        i += 1;
        const value = argv[i];
        if (value === undefined) {
          throw new Error(`Missing value for --harness (expected one of: ${VALID_HARNESSES.join(", ")})`);
        }
        for (const rawName of value.split(",")) {
          const name = rawName.trim();
          if (!VALID_HARNESSES.includes(name)) {
            throw new Error(
              `Unknown harness "${name}" for --harness. Valid harnesses: ${VALID_HARNESSES.join(", ")}.`
            );
          }
          harnessSet.add(name);
        }
        break;
      }

      case "--dry-run":
        args.dryRun = true;
        break;

      case "--uninstall":
        args.uninstall = true;
        break;

      case "--purge-marketplace":
        args.purgeMarketplace = true;
        break;

      case "--force":
        args.force = true;
        break;

      case "--json":
        args.json = true;
        break;

      case "-h":
      case "--help":
        args.help = true;
        break;

      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (harnessSet.size > 0) {
    args.harnesses = [...harnessSet];
  }

  if (args.purgeMarketplace && !args.uninstall) {
    throw new Error("--purge-marketplace requires --uninstall (it only makes sense as part of an uninstall).");
  }

  if (args.force && args.uninstall) {
    throw new Error("--force cannot be combined with --uninstall — there is nothing left to reinstall.");
  }

  if (args.force && args.harnesses && !args.harnesses.includes("codex")) {
    throw new Error(
      `--force only applies to codex (it bumps the codex plugin manifest's cachebuster); ` +
        `the current --harness selection (${args.harnesses.join(", ")}) does not include codex.`
    );
  }

  return args;
}

// ---------------------------------------------------------------------------
// Manifest reading + version drift detection (Task 2)
// ---------------------------------------------------------------------------
//
// Five files make up the "one repo, one version" contract this installer
// exists to protect (see docs/superpowers/specs/2026-07-25-harness-installer-design.md
// §2.2): package.json's `version`, `.claude-plugin/marketplace.json`'s
// `metadata.version` and `plugins[0].version`, and
// `plugins/gateway/.claude-plugin/plugin.json`'s `version` are meant to
// move together on every release. The Codex plugin manifest
// (`plugins/gateway-codex/.codex-plugin/plugin.json`) tracks its own,
// independent version and is deliberately excluded from the drift check.

/**
 * Read and JSON.parse a manifest file. Throws an Error whose message
 * always names the file's path — callers rely on that path showing up
 * verbatim so a missing/corrupt manifest is actionable, not a bare stack
 * trace.
 *
 * @param {string} filePath
 * @returns {any}
 */
function readJsonManifest(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const reason = err && err.code === "ENOENT" ? "file not found" : err instanceof Error ? err.message : String(err);
    throw new Error(`could not read manifest ${filePath}: ${reason}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `could not parse manifest ${filePath} as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Read the two manifests that make up the Claude Code side of the plugin:
 * the repo's marketplace registration and the gateway plugin's own
 * manifest. A missing or corrupt file degrades this block to `{ error }`
 * instead of throwing, so a Claude-side problem never prevents the Codex
 * block (read independently) from being reported.
 *
 * @param {string} repoRoot
 */
function readClaudeManifests(repoRoot) {
  const marketplacePath = path.join(repoRoot, ".claude-plugin", "marketplace.json");
  const pluginPath = path.join(repoRoot, "plugins", "gateway", ".claude-plugin", "plugin.json");
  try {
    const marketplace = readJsonManifest(marketplacePath);
    const plugin = readJsonManifest(pluginPath);
    const entry = (marketplace.plugins && marketplace.plugins[0]) || {};
    return {
      marketplaceName: marketplace.name,
      pluginName: entry.name,
      pluginVersion: plugin.version,
      marketplaceEntryVersion: entry.version,
      marketplaceMetaVersion: marketplace.metadata && marketplace.metadata.version,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read the two manifests that make up the Codex side of the plugin. Same
 * degrade-to-`{ error }` contract as {@link readClaudeManifests}.
 *
 * @param {string} repoRoot
 */
function readCodexManifests(repoRoot) {
  const marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
  const pluginPath = path.join(repoRoot, "plugins", "gateway-codex", ".codex-plugin", "plugin.json");
  try {
    const marketplace = readJsonManifest(marketplacePath);
    const plugin = readJsonManifest(pluginPath);
    const entry = (marketplace.plugins && marketplace.plugins[0]) || {};
    return {
      marketplaceName: marketplace.name,
      pluginName: entry.name,
      pluginVersion: plugin.version,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Compare the four version fields that are supposed to move together on
 * every release. Always returns all four values with their source path,
 * whether or not they agree, so callers (including --dry-run output in a
 * later task) can print them regardless of drift state.
 *
 * @param {string|undefined} packageVersion
 * @param {ReturnType<typeof readClaudeManifests>} claude
 */
function computeDrift(packageVersion, claude) {
  if (claude.error) {
    // Can't compare what we couldn't read. Fail loud rather than silently
    // reporting "no drift" when the truth is "unknown".
    return {
      detected: true,
      values: {},
      error: `cannot compute version drift: Claude manifests unavailable (${claude.error})`,
    };
  }

  const values = {
    packageVersion: { value: packageVersion, path: "package.json" },
    pluginVersion: { value: claude.pluginVersion, path: "plugins/gateway/.claude-plugin/plugin.json" },
    marketplaceEntryVersion: {
      value: claude.marketplaceEntryVersion,
      path: ".claude-plugin/marketplace.json (plugins[0].version)",
    },
    marketplaceMetaVersion: {
      value: claude.marketplaceMetaVersion,
      path: ".claude-plugin/marketplace.json (metadata.version)",
    },
  };

  const distinctValues = new Set(Object.values(values).map((entry) => entry.value));
  return { detected: distinctValues.size > 1, values };
}

/**
 * Read every version manifest this repo ships (package.json, the Claude
 * marketplace + plugin manifests, the Codex marketplace + plugin
 * manifests) and detect version drift across the four that are meant to
 * move together (see {@link computeDrift}).
 *
 * Pure function of `repoRoot`: only reads files under it, never writes,
 * never spawns a process. A missing/corrupt package.json is the one
 * exception to the "degrade, don't throw" behavior of the per-harness
 * blocks below — this repo's own package.json existing and parsing is a
 * base invariant of the checkout, not a per-harness condition for this
 * function to handle gracefully.
 *
 * @param {string} repoRoot
 * @returns {{
 *   claude: {marketplaceName: string, pluginName: string, pluginVersion: string, marketplaceEntryVersion: string, marketplaceMetaVersion: string}|{error: string},
 *   codex: {marketplaceName: string, pluginName: string, pluginVersion: string}|{error: string},
 *   packageVersion: string,
 *   drift: {detected: boolean, values: object, error?: string},
 * }}
 */
export function readRepoManifests(repoRoot) {
  const pkg = readJsonManifest(path.join(repoRoot, "package.json"));
  const packageVersion = pkg.version;

  const claude = readClaudeManifests(repoRoot);
  const codex = readCodexManifests(repoRoot);
  const drift = computeDrift(packageVersion, claude);

  return { claude, codex, packageVersion, drift };
}

// ---------------------------------------------------------------------------
// Harness detection + state parsing (Task 3)
// ---------------------------------------------------------------------------
//
// Two independent, pure-with-respect-to-side-effects concerns:
//
//   - detectHarnesses: is the CLI even on PATH, and what version does it
//     report? This is exactly captureBinaryVersion()'s job (see
//     scripts/baseline-capture.mjs), imported rather than duplicated (spec
//     §6.1). `probe` is injectable for tests; production wiring defaults it
//     to the real captureBinaryVersion.
//
//   - parseClaudeState / parseCodexState: given stdout the caller already
//     captured from each harness's own `plugin list --json` /
//     `plugin marketplace list --json`, extract what Task 4's planning
//     needs. Neither spawns a process — that split matters because Claude
//     and Codex disagree on what happens when state can't be read: Claude
//     aborts that harness (no guessing), Codex degrades to "install/update
//     anyway" because `codex plugin add` is idempotent (spec §6.4). Setting
//     `parseError` and returning, rather than throwing, is what lets the
//     caller make that harness-specific call instead of this function
//     deciding for it.

/**
 * Find the entry in an already-parsed `plugin list --json` /
 * `plugin marketplace list --json` array matching `matcher`. Tolerates
 * `list` not being an array (returns undefined) so a well-formed-but-wrong
 * shape degrades to "not found" instead of throwing here.
 */
function findEntry(list, matcher) {
  return Array.isArray(list) ? list.find(matcher) : undefined;
}

/**
 * Detect which harness CLIs are present on this machine and what version
 * each reports.
 *
 * `selection` mirrors `parseCliArgs`' `harnesses` field: `null` (or empty)
 * means "every harness this installer knows about" (`VALID_HARNESSES`), and
 * a harness not being found is just reported — nothing was explicitly
 * requested, so "not installed" is a fact, not an error. A non-empty
 * selection is a restriction: only those harnesses are probed, and if any
 * of them isn't detected this throws — naming a harness explicitly means
 * the caller expected it to be there (spec §5/§6.1: "pedir un harness que
 * no está instalado es error, no skip silencioso").
 *
 * @param {string[]|null} selection
 * @param {{probe?: (cmd: string) => {found: boolean, exitStatus: number|null, firstLine: string|null}}} [options]
 * @returns {{name: string, detected: boolean, cliVersion: string|null}[]}
 */
export function detectHarnesses(selection, { probe = captureBinaryVersion } = {}) {
  const names = selection && selection.length > 0 ? selection : VALID_HARNESSES;

  const results = names.map((name) => {
    const probed = probe(name);
    return {
      name,
      detected: Boolean(probed.found),
      cliVersion: probed.found ? probed.firstLine : null,
    };
  });

  if (selection && selection.length > 0) {
    const missing = results.filter((entry) => !entry.detected);
    if (missing.length > 0) {
      throw new Error(
        `Requested harness${missing.length > 1 ? "es" : ""} not detected on this machine: ` +
          `${missing.map((entry) => entry.name).join(", ")}. ` +
          `Install the missing CLI, or remove it from --harness.`
      );
    }
  }

  return results;
}

/**
 * Parse Claude Code's install state from already-captured stdout of
 * `claude plugin marketplace list --json` and `claude plugin list --json`
 * (spec §6.4). Pure: never spawns a process.
 *
 * Real shapes captured in Task 0 (see
 * docs/superpowers/plans/2026-07-25-harness-installer.md, Task 0 §Paso 2):
 * marketplace entries are `{name, source, path?, installLocation}` (a
 * `directory`-sourced entry has `path` === `installLocation`; non-local
 * sources have neither `source: "directory"` nor a `path` — irrelevant
 * here beyond "not our marketplace"). Plugin entries are
 * `{id: "<plugin>@<marketplace>", version, ...}` — `version` can be the
 * literal string `"unknown"` (seen on 3 real plugins); never assume semver.
 *
 * @param {{marketplaceListStdout: string, pluginListStdout: string}} stdouts
 * @param {{marketplaceName: string, pluginId: string}} keys
 * @returns {{marketplaceRegistered: boolean, marketplaceSource: string|null, installedVersion: string|null, parseError: string|null}}
 */
export function parseClaudeState({ marketplaceListStdout, pluginListStdout }, { marketplaceName, pluginId }) {
  let marketplaceList;
  let pluginList;
  const parseErrors = [];

  try {
    marketplaceList = JSON.parse(marketplaceListStdout);
  } catch (err) {
    parseErrors.push(`plugin marketplace list --json: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    pluginList = JSON.parse(pluginListStdout);
  } catch (err) {
    parseErrors.push(`plugin list --json: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (parseErrors.length > 0) {
    return {
      marketplaceRegistered: false,
      marketplaceSource: null,
      installedVersion: null,
      parseError: `could not parse claude state (${parseErrors.join("; ")})`,
    };
  }

  const marketplaceEntry = findEntry(marketplaceList, (entry) => entry.name === marketplaceName);
  const pluginEntry = findEntry(pluginList, (entry) => entry.id === pluginId);

  return {
    marketplaceRegistered: Boolean(marketplaceEntry),
    marketplaceSource: marketplaceEntry ? marketplaceEntry.installLocation ?? marketplaceEntry.path ?? null : null,
    installedVersion: pluginEntry ? pluginEntry.version : null,
    parseError: null,
  };
}

/**
 * Parse Codex's install state from already-captured stdout of
 * `codex plugin marketplace list --json` and `codex plugin list --json`
 * (spec §6.4, plan Task 0 §Paso 2.4 — both commands were confirmed to
 * exist and were captured live; the original spec draft only named
 * `plugin list --json` before that verification). Pure: never spawns a
 * process.
 *
 * Real shapes captured in Task 0: marketplace entries are
 * `{name, root, marketplaceSource: {sourceType, source}}`. Plugin entries
 * live under two arrays, `installed` and `available`
 * (`{pluginId, version, marketplaceSource, ...}` each) — a plugin only in
 * `available` is offered by a registered marketplace but not installed
 * yet, so `installedVersion` stays `null` for it even though
 * `marketplaceRegistered` is `true`.
 *
 * @param {{marketplaceListStdout: string, pluginListStdout: string}} stdouts
 * @param {{marketplaceName: string, pluginId: string}} keys
 * @returns {{marketplaceRegistered: boolean, marketplaceSource: string|null, installedVersion: string|null, parseError: string|null}}
 */
export function parseCodexState({ marketplaceListStdout, pluginListStdout }, { marketplaceName, pluginId }) {
  let marketplaceList;
  let pluginList;
  const parseErrors = [];

  try {
    marketplaceList = JSON.parse(marketplaceListStdout);
  } catch (err) {
    parseErrors.push(`plugin marketplace list --json: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    pluginList = JSON.parse(pluginListStdout);
  } catch (err) {
    parseErrors.push(`plugin list --json: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (parseErrors.length > 0) {
    return {
      marketplaceRegistered: false,
      marketplaceSource: null,
      installedVersion: null,
      parseError: `could not parse codex state (${parseErrors.join("; ")})`,
    };
  }

  const marketplaceEntry = findEntry(marketplaceList && marketplaceList.marketplaces, (entry) => entry.name === marketplaceName);
  const installedEntry = findEntry(pluginList && pluginList.installed, (entry) => entry.pluginId === pluginId);

  return {
    marketplaceRegistered: Boolean(marketplaceEntry),
    marketplaceSource: marketplaceEntry ? marketplaceEntry.root ?? null : null,
    installedVersion: installedEntry ? installedEntry.version : null,
    parseError: null,
  };
}

// ---------------------------------------------------------------------------
// Pure per-harness install/update/uninstall planning (Task 4)
// ---------------------------------------------------------------------------
//
// planClaude / planCodex turn (repoRoot, the per-harness block of
// readRepoManifests' output, the per-harness parseClaudeState/parseCodexState
// result, and a mode) into the exact ordered sequence of argv this installer
// would run — nothing more. Zero side effects: no spawnSync, no fs writes.
// Task 6 is what actually executes the returned steps.
//
// Mirrors spec §6.2 (Claude sequence table) / §6.3 (Codex sequence table).
// The one behavioral difference between the two harnesses, per §6.4, is what
// happens when `state.parseError` is set: Claude aborts that harness (return
// no steps — guessing install-vs-update state is exactly what produces
// mis-registered installs) while Codex degrades to running `plugin add`
// anyway, because that command is idempotent (safe whether or not it was
// already installed).
//
// `purgeMarketplace` isn't in the plan brief's one-line interface signature,
// but is required to build the `+ marketplace remove` step for uninstall
// (mirrors `parseCliArgs`' own `purgeMarketplace` field — main() will pass
// `args.purgeMarketplace` straight through once Task 6 wires this up).

const CLAUDE_NEXT_STEPS = [
  "Run /reload-plugins in any open Claude Code session (or restart it) — plugin changes on disk are not picked up live.",
];

const CODEX_NEXT_STEPS = [
  "Open a NEW Codex thread — a session already open keeps the old copy of the skill loaded.",
];

// Both harnesses cache a remote/git-sourced marketplace under their own
// config dir rather than the source URL itself — confirmed live on this
// machine for Claude (`~/.claude/plugins/known_marketplaces.json`: every
// git/github-sourced entry has `installLocation: "<home>/.claude/plugins/
// marketplaces/<name>"`, while the one directory-sourced entry has
// `installLocation` equal to the literal checkout path). Codex's `plugin
// marketplace add` documents the same local-vs-git split ("Add a local or
// Git marketplace..."); by the same cache convention its git snapshots land
// under `~/.codex/plugins/marketplaces/<name>` too. Matching on that shape
// (rather than requiring the real homedir) keeps this a plain string check,
// independent of whose home directory the mismatch was captured from.
const MARKETPLACE_CACHE_PATH_PATTERN = /\/\.(?:claude|codex)\/plugins\/marketplaces\//;

function looksLikeMarketplaceCachePath(actualPath) {
  return typeof actualPath === "string" && MARKETPLACE_CACHE_PATH_PATTERN.test(actualPath);
}

/**
 * Build the actionable "marketplace registered somewhere else" error shared
 * by planClaude/planCodex's mismatch branch (spec §4 decision 4: print both
 * paths and the exact `marketplace remove` escape hatch, with its warning
 * that removing a marketplace uninstalls every plugin registered under it).
 *
 * The remediation hint branches on what `actualPath` looks like (Finding 2
 * of the final whole-branch review — the two most common real triggers
 * produced a misleading "just remove it" message):
 *   - a path under the harness's own marketplace cache dir means it was
 *     registered from a remote/git source (e.g. README's manual "Opción 1",
 *     `claude plugin marketplace add https://github.com/...`) — the
 *     registered path is an internal cache the user never chose, and
 *     blindly telling them to remove it would uninstall a working plugin.
 *   - any other local path is a plain filesystem mismatch — most likely a
 *     git worktree or a second clone of this same repo (this repo's own
 *     dev workflow uses worktrees, so a contributor hits this routinely).
 *
 * @param {string} harnessCmd - "claude" or "codex"
 * @param {string} marketplaceName
 * @param {string} expectedPath
 * @param {string} actualPath
 */
function mismatchError(harnessCmd, marketplaceName, expectedPath, actualPath) {
  const harnessLabel = harnessCmd === "claude" ? "Claude" : "Codex";
  const remediationHint = looksLikeMarketplaceCachePath(actualPath)
    ? `  this looks like ${harnessCmd}'s internal marketplace cache path — it was likely registered from a ` +
      `remote/git source, not a local checkout; only remove it if you're intentionally switching to a ` +
      `local-checkout install.\n`
    : `  if this looks like a git worktree or a second clone of the same repo, run the installer from the ` +
      `primary checkout instead of removing the marketplace.\n`;

  return (
    `${harnessLabel}'s "${marketplaceName}" marketplace is already registered ` +
    `pointing at a different path than this repo — refusing to silently repoint it.\n` +
    `  expected (this repo): ${expectedPath}\n` +
    `  actual (already registered): ${actualPath}\n` +
    remediationHint +
    `To fix: ${harnessCmd} plugin marketplace remove ${marketplaceName}\n` +
    `  (warning: this uninstalls every plugin currently registered under that marketplace — you'll need to re-add it pointing here)`
  );
}

/**
 * Pure planning for Claude Code. See spec §6.2 for the sequence table this
 * mirrors.
 *
 * @param {{
 *   repoRoot: string,
 *   manifest: {marketplaceName: string, pluginName: string, pluginVersion: string},
 *   state: {marketplaceRegistered: boolean, marketplaceSource: string|null, installedVersion: string|null, parseError: string|null},
 *   mode: "install"|"uninstall",
 *   purgeMarketplace?: boolean,
 * }} args
 * @returns {{action: string|null, steps: {label: string, argv: string[]|null, mutating: boolean}[], nextSteps: string[], error: string|null, installedVersionBefore: string|null}}
 */
export function planClaude({ repoRoot, manifest, state, mode, purgeMarketplace = false }) {
  const pluginId = `${manifest.pluginName}@${manifest.marketplaceName}`;

  if (mode === "uninstall") {
    const steps = [
      { label: `uninstall ${pluginId}`, argv: ["claude", "plugin", "uninstall", pluginId], mutating: true },
    ];
    if (purgeMarketplace) {
      steps.push({
        label: `remove marketplace ${manifest.marketplaceName}`,
        argv: ["claude", "plugin", "marketplace", "remove", manifest.marketplaceName],
        mutating: true,
      });
    }
    return {
      action: "uninstalled",
      steps,
      nextSteps: CLAUDE_NEXT_STEPS,
      error: null,
      installedVersionBefore: state.installedVersion,
    };
  }

  // mode === "install"
  if (state.parseError) {
    // Fail loud rather than guess: without a readable state, we don't know
    // if this is a fresh install or an update, and "run it and see" is
    // exactly the pattern §4 decision 3 forbids.
    return {
      action: "blocked",
      steps: [],
      nextSteps: [],
      error:
        `Could not read Claude's current plugin/marketplace state (${state.parseError}). ` +
        `Not guessing whether ${pluginId} is already installed — run these manually to check, then re-run this installer: ` +
        `claude plugin marketplace list --json && claude plugin list --json`,
      installedVersionBefore: state.installedVersion,
    };
  }

  if (state.marketplaceRegistered && state.marketplaceSource !== repoRoot) {
    return {
      action: "mismatch",
      steps: [],
      nextSteps: [],
      error: mismatchError("claude", manifest.marketplaceName, repoRoot, state.marketplaceSource),
      installedVersionBefore: state.installedVersion,
    };
  }

  const steps = [];
  if (!state.marketplaceRegistered) {
    steps.push({
      label: `register marketplace ${manifest.marketplaceName}`,
      argv: ["claude", "plugin", "marketplace", "add", repoRoot],
      mutating: true,
    });
  } else {
    // Registered and pointing here: still refresh it every run (cheap, and
    // it's the only way marketplace-level changes get picked up even when
    // the plugin version itself hasn't moved — spec §6.2 row 2/3).
    steps.push({
      label: `refresh marketplace ${manifest.marketplaceName}`,
      argv: ["claude", "plugin", "marketplace", "update", manifest.marketplaceName],
      mutating: true,
    });
  }

  let action;
  if (!state.installedVersion) {
    steps.push({ label: `install ${pluginId}`, argv: ["claude", "plugin", "install", pluginId], mutating: true });
    action = "installed";
  } else if (state.installedVersion !== manifest.pluginVersion) {
    steps.push({ label: `update ${pluginId}`, argv: ["claude", "plugin", "update", pluginId], mutating: true });
    action = "updated";
  } else {
    action = "unchanged";
  }

  return {
    action,
    steps,
    nextSteps: CLAUDE_NEXT_STEPS,
    error: null,
    installedVersionBefore: state.installedVersion,
  };
}

/**
 * Pure planning for Codex. See spec §6.3 for the sequence table this
 * mirrors.
 *
 * @param {{
 *   repoRoot: string,
 *   manifest: {marketplaceName: string, pluginName: string, pluginVersion: string},
 *   state: {marketplaceRegistered: boolean, marketplaceSource: string|null, installedVersion: string|null, parseError: string|null},
 *   mode: "install"|"uninstall",
 *   force?: boolean,
 *   purgeMarketplace?: boolean,
 * }} args
 * @returns {{action: string|null, steps: {label: string, argv: string[]|null, mutating: boolean, pluginRoot?: string}[], nextSteps: string[], error: string|null, installedVersionBefore: string|null}}
 */
export function planCodex({ repoRoot, manifest, state, mode, force = false, purgeMarketplace = false }) {
  const pluginId = `${manifest.pluginName}@${manifest.marketplaceName}`;

  if (mode === "uninstall") {
    const steps = [{ label: `remove ${pluginId}`, argv: ["codex", "plugin", "remove", pluginId], mutating: true }];
    if (purgeMarketplace) {
      steps.push({
        label: `remove marketplace ${manifest.marketplaceName}`,
        argv: ["codex", "plugin", "marketplace", "remove", manifest.marketplaceName],
        mutating: true,
      });
    }
    return {
      action: "uninstalled",
      steps,
      nextSteps: CODEX_NEXT_STEPS,
      error: null,
      installedVersionBefore: state.installedVersion,
    };
  }

  // mode === "install"
  if (state.parseError) {
    // Unlike Claude, Codex degrades instead of aborting (spec §6.4 point 3):
    // `codex plugin add` is the same idempotent command for install and
    // update, so it's safe to run even with state unknown. Deliberately no
    // marketplace-add step here: parseCodexState's parseError branch always
    // reports `marketplaceRegistered: false` as a safe *parser* default, not
    // a verified "actually absent" — adding it on top of an unreadable state
    // could conflict with a marketplace that's genuinely already there.
    return {
      action: "installed-or-refreshed",
      steps: [{ label: `add/refresh ${pluginId}`, argv: ["codex", "plugin", "add", pluginId], mutating: true }],
      nextSteps: CODEX_NEXT_STEPS,
      error: null,
      installedVersionBefore: state.installedVersion,
    };
  }

  if (state.marketplaceRegistered && state.marketplaceSource !== repoRoot) {
    return {
      action: "mismatch",
      steps: [],
      nextSteps: [],
      error: mismatchError("codex", manifest.marketplaceName, repoRoot, state.marketplaceSource),
      installedVersionBefore: state.installedVersion,
    };
  }

  const steps = [];
  if (!state.marketplaceRegistered) {
    steps.push({
      label: `register marketplace ${manifest.marketplaceName}`,
      argv: ["codex", "plugin", "marketplace", "add", repoRoot],
      mutating: true,
    });
  }
  // Registered and pointing here: no step. Unlike Claude, there is no cheap
  // "refresh" for a local marketplace — `codex plugin marketplace upgrade`
  // only refreshes Git-sourced snapshots (spec §6.3 note) — and the
  // idempotent `plugin add` below covers picking up a new plugin version.

  if (force) {
    // The installer's one sanctioned write to a tracked file (spec §4
    // decision 6): bump the codex plugin manifest's cachebuster so a
    // same-version content change is actually picked up. This is a plain
    // Node fs write (Task 5's applyCachebuster), never a subprocess — so
    // unlike every other step here, there is no real argv to run, and
    // `argv` is `null` rather than a fabricated command. `pluginRoot` gives
    // Task 6 the directory applyCachebuster(pluginRoot, token) needs.
    const pluginRoot = path.join(repoRoot, "plugins", "gateway-codex");
    steps.push({
      label: `bump the Codex plugin manifest's cachebuster (repo write, not a CLI call): ${path.join(pluginRoot, ".codex-plugin", "plugin.json")}`,
      argv: null,
      mutating: true,
      pluginRoot,
    });
    steps.push({ label: `add/refresh ${pluginId}`, argv: ["codex", "plugin", "add", pluginId], mutating: true });
    return {
      action: "forced",
      steps,
      nextSteps: CODEX_NEXT_STEPS,
      error: null,
      installedVersionBefore: state.installedVersion,
    };
  }

  steps.push({ label: `add/refresh ${pluginId}`, argv: ["codex", "plugin", "add", pluginId], mutating: true });

  let action;
  if (!state.installedVersion) {
    action = "installed";
  } else if (state.installedVersion !== manifest.pluginVersion) {
    action = "updated";
  } else {
    action = "unchanged";
  }

  return {
    action,
    steps,
    nextSteps: CODEX_NEXT_STEPS,
    error: null,
    installedVersionBefore: state.installedVersion,
  };
}

/**
 * Closes the `--force` validation gap `parseCliArgs` deliberately left open
 * (Task 1): `--force` with no explicit `--harness` (the default = "every
 * harness detected") can only be checked against codex's presence once
 * harness detection has actually run, which wasn't available yet in Task 1.
 *
 * When `args.harnesses` was explicit, `parseCliArgs` has already thrown if
 * that selection excluded codex — this function only has anything left to
 * check for the default (`harnesses: null`) case, against the harnesses
 * `detectHarnesses` actually found (Task 3's reviewer-confirmed pattern:
 * `detectHarnesses(null, {probe}).filter(h => h.detected)`).
 *
 * Intentionally a standalone step rather than logic inside planCodex:
 * planCodex is only ever invoked for a harness that's already in scope, so
 * it has no reason to know whether *that* was a valid thing to do — this is
 * a CLI-usage concern, checked once, before any per-harness planning runs.
 *
 * @param {{force: boolean, harnesses: string[]|null}} args - parseCliArgs' output
 * @param {{name: string, detected: boolean}[]} detectedHarnesses - detectHarnesses' output
 */
export function validateForceSelection(args, detectedHarnesses) {
  if (!args.force) return;
  if (args.harnesses && args.harnesses.length > 0) return; // already validated by parseCliArgs

  const effective = detectedHarnesses.filter((h) => h.detected).map((h) => h.name);
  if (!effective.includes("codex")) {
    throw new Error(
      `--force only applies to codex (it bumps the codex plugin manifest's cachebuster); ` +
        `no --harness was given and codex was not detected on this machine ` +
        `(detected: ${effective.length > 0 ? effective.join(", ") : "none"}). ` +
        `Install codex, pass --harness codex explicitly once it is, or drop --force.`
    );
  }
}

// ---------------------------------------------------------------------------
// Codex cachebuster for --force (Task 5)
// ---------------------------------------------------------------------------
//
// Mirrors ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py
// (spec §2.4/§4 decision 6): same semantics, reimplemented in plain Node so
// this installer never depends on python3 or on that skill path existing on
// a colleague's machine. `bumpCachebuster` is that script's
// `with_cachebuster` — pure, replaces rather than stacks the `+codex.<token>`
// suffix. `applyCachebuster` is its `main()` file-write half, wired to the
// `pluginRoot` field planCodex's `--force` step already produces (Task 4,
// above) so Task 6's executor can call it directly against that step.

const CACHEBUSTER_PREFIX = "codex";

/**
 * Format `now` as a UTC timestamp `YYYYMMDDHHMMSS` and sanitize it to
 * `[a-z0-9-]`, matching update_plugin_cachebuster.py's
 * `default_cachebuster` + `sanitize_cachebuster`. A real timestamp is
 * already all digits, so the sanitize pass is a no-op in practice — kept
 * anyway for parity with the Python contract this mirrors.
 *
 * `now` is an injectable parameter (defaults to `new Date()`) so tests can
 * assert on the token's shape without a real file write ever depending on
 * wall-clock timing to pass reliably.
 *
 * @param {Date} [now]
 * @returns {string}
 */
function defaultCachebusterToken(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const raw =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Rewrite `version` to carry a single `+codex.<token>` suffix, keeping
 * everything before the first `+` and discarding any prior build-metadata
 * suffix (codex's own or otherwise) rather than stacking onto it. Pure —
 * mirrors update_plugin_cachebuster.py::with_cachebuster exactly.
 *
 * @param {string} version
 * @param {string} token
 * @returns {string}
 */
export function bumpCachebuster(version, token) {
  const versionPrefix = version.split("+")[0];
  return `${versionPrefix}+${CACHEBUSTER_PREFIX}.${token}`;
}

/**
 * Does `version` already carry a dev cachebuster suffix? Used for the
 * persistent warning that a `--force`-bumped manifest needs cleaning up
 * before release (spec §4 decision 6).
 *
 * @param {string} version
 * @returns {boolean}
 */
export function hasDevCachebuster(version) {
  return typeof version === "string" && version.includes(`+${CACHEBUSTER_PREFIX}.`);
}

/**
 * The installer's one sanctioned write to a tracked file (spec §4 decision
 * 6): bump the Codex plugin manifest's version in place so a same-version
 * content change is actually picked up by Codex's plugin cache. Preserves
 * every other field and the file's formatting (2-space indent, single
 * trailing newline) — only `version` changes.
 *
 * @param {string} pluginRoot - e.g. `<repoRoot>/plugins/gateway-codex`, the
 *   same value planCodex's `--force` step already carries as `pluginRoot`.
 * @param {string} [token] - defaults to a fresh UTC-timestamp token.
 * @returns {{from: string, to: string, path: string}}
 */
export function applyCachebuster(pluginRoot, token = defaultCachebusterToken()) {
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifest = readJsonManifest(manifestPath);

  const from = manifest.version;
  if (typeof from !== "string" || !from.trim()) {
    throw new Error(`${manifestPath} must contain a non-empty string "version".`);
  }

  const to = bumpCachebuster(from, token);
  manifest.version = to;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { from, to, path: manifestPath };
}

// ---------------------------------------------------------------------------
// Execution, reporting, --json output, exit codes (Task 6)
// ---------------------------------------------------------------------------
//
// executePlan turns the pure plans from planClaude/planCodex into real
// results: it runs each harness's steps in order via an injectable `exec`
// (production wiring: defaultExec, a thin spawnSync wrapper), stopping that
// harness's remaining steps as soon as one fails (spec §7.4) — a failure in
// one harness never stops the other, because each plan is executed
// independently in the `plans.map()` below (spec §4 decision 9).
//
// renderReport/buildJson/computeExitCode all take the same aggregate
// `result` object main() assembles (repoRoot, dryRun, uninstall, versionDrift,
// devCachebusterWarning, harnesses[], summary, error) — see docs/superpowers/specs/
// 2026-07-25-harness-installer-design.md §7.2 for the JSON shape this is
// built to satisfy (schemaVersion, harnesses[].commands[].argv, summary,
// exitCode are the fields the plan's test list checks for explicitly; the
// rest of the shape below is a reasonable superset, not a stricter contract).
//
// devCachebusterWarning is informational only (spec §4 decision 6:
// hasDevCachebuster was built in Task 5 but never wired anywhere until now)
// — it never feeds computeExitCode and never alters install/update/uninstall
// behavior, same contract as versionDrift.

/** Read-only state probes (`plugin list --json`, `plugin marketplace list
 * --json`) — cheap, never mutate, run even in --dry-run so the plan they
 * feed is real (spec §7.5). */
export const STATE_TIMEOUT_MS = 10_000;

/** Mutating commands (install/update/uninstall/marketplace add/update/
 * remove) and the codex --force cachebuster write. Generous because plugin
 * installs can involve real network/cache work. */
export const MUTATION_TIMEOUT_MS = 120_000;

// Cheap defense for spec §2.4/§7.4: if stdout/stderr carries a marker that
// looks like a hook/wrapper denied the command outright, say so explicitly
// rather than just reporting a bare nonzero exit. Spec §7.4 names three
// markers: `permissionDecision`, `"deny"`, `BLOCKED:`. `\bdeny\b` (word
// boundary, not a bare substring match) catches both a quoted JSON value
// (`"decision":"deny"`) and a plain-text one (`PreToolUse hook result: deny`)
// without also matching unrelated words like "denied"/"denying".
const HOOK_BLOCK_PATTERN = /permissionDecision|BLOCKED:|\bdeny\b/;

function isHookBlocked(text) {
  return typeof text === "string" && HOOK_BLOCK_PATTERN.test(text);
}

function baseCommandFields(step) {
  return { label: step.label, argv: step.argv, mutating: step.mutating };
}

function skippedCommand(step, skipReason) {
  return {
    ...baseCommandFields(step),
    executed: false,
    skipped: true,
    skipReason,
    exitStatus: null,
    stdout: null,
    stderr: null,
    timedOut: false,
    durationMs: null,
    timeoutMs: null,
    hookBlockDetected: false,
  };
}

/**
 * Run one harness's plan to completion (or to its first failure). Pure with
 * respect to `plan`/`exec`/`dryRun` in the sense that all its side effects
 * are mediated through the injected `exec` and, for the one non-subprocess
 * step Codex's --force produces, `applyCachebuster` (Task 5) — never a bare
 * `spawnSync` of its own.
 *
 * @param {{name: string, steps: {label:string, argv:string[]|null, mutating:boolean, pluginRoot?:string}[], error: string|null}} plan
 * @param {{exec: (argv:string[], opts:{timeoutMs:number}) => {exitStatus:number|null, stdout:string, stderr:string, timedOut:boolean, durationMs:number}, dryRun: boolean}} options
 * @returns {{name: string, status: "ok"|"failed", hookBlocked: boolean, commands: object[]}}
 */
function executeSinglePlan(plan, { exec, dryRun }) {
  // A plan-level error (marketplace mismatch, or Claude's parseError abort)
  // means planning already refused to produce any steps — nothing to run,
  // and the harness is failed by definition of that refusal.
  if (plan.error) {
    return { name: plan.name, status: "failed", hookBlocked: false, commands: [] };
  }

  const commands = [];
  let hookBlocked = false;
  let stopped = false;

  for (const step of plan.steps) {
    if (stopped) {
      commands.push(skippedCommand(step, "previous-step-failed"));
      continue;
    }

    if (dryRun && step.mutating) {
      commands.push(skippedCommand(step, "dry-run"));
      continue;
    }

    if (step.argv === null) {
      // Codex --force's cachebuster step (Task 4/planCodex): a direct repo
      // file write via applyCachebuster (Task 5), never a subprocess call.
      // The dry-run/failure-skip checks above already ran for this step
      // like any other mutating step, so reaching here means it's really
      // meant to execute now.
      const start = Date.now();
      try {
        const { from, to } = applyCachebuster(step.pluginRoot);
        commands.push({
          ...baseCommandFields(step),
          executed: true,
          skipped: false,
          exitStatus: 0,
          stdout: `bumped cachebuster: ${from} -> ${to}`,
          stderr: "",
          timedOut: false,
          durationMs: Date.now() - start,
          timeoutMs: null,
          hookBlockDetected: false,
        });
      } catch (err) {
        commands.push({
          ...baseCommandFields(step),
          executed: true,
          skipped: false,
          exitStatus: 1,
          stdout: "",
          stderr: firstNLines(err instanceof Error ? err.message : String(err), MATRIX_OUTPUT_MAX_LINES),
          timedOut: false,
          durationMs: Date.now() - start,
          timeoutMs: null,
          hookBlockDetected: false,
        });
        stopped = true;
      }
      continue;
    }

    const timeoutMs = MUTATION_TIMEOUT_MS;
    const result = exec(step.argv, { timeoutMs });
    const rawStdout = result.stdout || "";
    const rawStderr = result.stderr || "";
    const blocked = isHookBlocked(rawStderr) || isHookBlocked(rawStdout);
    if (blocked) hookBlocked = true;

    commands.push({
      ...baseCommandFields(step),
      executed: true,
      skipped: false,
      exitStatus: result.exitStatus,
      stdout: rawStdout,
      stderr: firstNLines(rawStderr, MATRIX_OUTPUT_MAX_LINES),
      timedOut: Boolean(result.timedOut),
      durationMs: typeof result.durationMs === "number" ? result.durationMs : null,
      timeoutMs,
      hookBlockDetected: blocked,
    });

    if (result.timedOut || result.exitStatus !== 0) {
      stopped = true;
    }
  }

  return { name: plan.name, status: stopped ? "failed" : "ok", hookBlocked, commands };
}

/**
 * Execute every harness's plan. Each plan is run independently — a failure
 * in one never stops or skips the other (spec §4 decision 9); only steps
 * *within* the same harness's plan stop once that harness hits a failure.
 *
 * @param {{name:string, steps:object[], error:string|null}[]} plans
 * @param {{exec: Function, dryRun?: boolean}} options
 * @returns {{name:string, status:"ok"|"failed", hookBlocked:boolean, commands:object[]}[]}
 */
export function executePlan(plans, { exec, dryRun = false }) {
  return plans.map((plan) => executeSinglePlan(plan, { exec, dryRun }));
}

/**
 * Production `exec`: a thin spawnSync wrapper matching the shape
 * executePlan's steps expect. Never thrown from — a spawn error (e.g.
 * ENOENT because some *other* wrapper shadows the harness binary) is
 * reported as a failed command, not an uncaught exception, so one bad
 * command can't take down the whole run.
 */
function defaultExec(argv, { timeoutMs }) {
  const [cmd, ...rest] = argv;
  const start = Date.now();
  const spawned = spawnSync(cmd, rest, { encoding: "utf8", timeout: timeoutMs });
  const durationMs = Date.now() - start;
  const timedOut = Boolean(spawned.error && spawned.error.code === "ETIMEDOUT");

  if (spawned.error && !timedOut) {
    return { exitStatus: null, stdout: spawned.stdout || "", stderr: spawned.error.message, timedOut: false, durationMs };
  }

  return {
    exitStatus: timedOut ? null : typeof spawned.status === "number" ? spawned.status : 1,
    stdout: spawned.stdout || "",
    stderr: spawned.stderr || "",
    timedOut,
    durationMs,
  };
}

const NO_HARNESS_DETECTED_ERROR =
  `No harness detected on this machine (looked for: ${VALID_HARNESSES.join(", ")}). ` +
  `Install at least one of them and re-run, or check PATH.`;

function computeSummary(harnesses) {
  const summary = { installed: 0, updated: 0, unchanged: 0, uninstalled: 0, failed: 0, skipped: 0 };
  for (const h of harnesses) {
    if (!h.detected) {
      summary.skipped += 1;
      continue;
    }
    if (h.status === "failed") {
      summary.failed += 1;
      continue;
    }
    switch (h.action) {
      case "installed":
        summary.installed += 1;
        break;
      case "updated":
      case "forced":
      case "installed-or-refreshed":
        summary.updated += 1;
        break;
      case "uninstalled":
        summary.uninstalled += 1;
        break;
      default:
        summary.unchanged += 1;
    }
  }
  return summary;
}

/**
 * Compute the installer's exit code from the aggregate result. Exactly two
 * values (spec §7.3): 1 for "no harness detected", "a global error was set",
 * or "any attempted harness failed" (mismatch, blocked, command failure,
 * timeout); 0 otherwise, including every harness reporting "unchanged".
 *
 * @param {{error?: string|null, harnesses: {detected:boolean, status?:string}[]}} result
 * @returns {0|1}
 */
export function computeExitCode(result) {
  if (result.error) return 1;
  const harnesses = result.harnesses || [];
  if (harnesses.length === 0 || !harnesses.some((h) => h.detected)) return 1;
  const anyFailed = harnesses.some((h) => h.detected && h.status === "failed");
  return anyFailed ? 1 : 0;
}

/**
 * Build the exact `--json` object (spec §7.2). Always recomputes `exitCode`
 * from `computeExitCode` rather than trusting a value the caller may have
 * stamped on `result` — one source of truth, no risk of the two drifting
 * apart.
 *
 * @param {object} result
 * @returns {object}
 */
export function buildJson(result) {
  return {
    schemaVersion: 1,
    repoRoot: result.repoRoot,
    dryRun: Boolean(result.dryRun),
    uninstall: Boolean(result.uninstall),
    versionDrift: result.versionDrift ?? { detected: false, values: {} },
    devCachebusterWarning: result.devCachebusterWarning ?? { detected: false, version: null },
    harnesses: result.harnesses ?? [],
    summary: result.summary ?? computeSummary(result.harnesses ?? []),
    error: result.error ?? null,
    exitCode: computeExitCode(result),
  };
}

function renderCommandLine(cmd) {
  const argvText = cmd.argv ? cmd.argv.join(" ") : cmd.label;
  const lines = [];

  if (cmd.skipped) {
    if (cmd.skipReason === "dry-run") {
      lines.push(`  [dry-run] would run: ${argvText}`);
    } else {
      lines.push(`  [SKIPPED] ${argvText} (previous step in this harness failed)`);
    }
    return lines;
  }

  if (cmd.timedOut) {
    lines.push(`  [FAILED] ${argvText} — timed out after ${cmd.timeoutMs}ms`);
  } else if (cmd.exitStatus !== 0) {
    lines.push(`  [FAILED] ${argvText} — exit status ${cmd.exitStatus}`);
  } else {
    lines.push(`  [ok] ${argvText}`);
  }

  if (cmd.timedOut || cmd.exitStatus !== 0) {
    if (cmd.stderr) lines.push(`    stderr: ${cmd.stderr}`);
    if (cmd.hookBlockDetected) {
      lines.push(
        `    it looks like a wrapper/hook intercepted this command — run it directly in your own terminal, outside the agent session`
      );
    }
    lines.push(`    run this by hand in your terminal: ${argvText}`);
  }

  return lines;
}

/**
 * Human-readable rendering of the same aggregate `result` buildJson turns
 * into JSON (spec §7.1, adapted to this file's English convention rather
 * than the design doc's Spanish illustration). Every mutating step — run,
 * skipped, or dry-run — gets one line naming its literal argv, so
 * `--dry-run`'s "print the exact plan" promise (spec §7.5) holds for the
 * text output too.
 *
 * @param {object} result
 * @returns {string}
 */
export function renderReport(result) {
  const lines = [`gateway-plugin-cc installer — repo ${result.repoRoot}`, ""];

  if (result.versionDrift && result.versionDrift.detected) {
    lines.push("WARNING: version drift detected across the manifests that are supposed to move together:");
    if (result.versionDrift.error) lines.push(`  ${result.versionDrift.error}`);
    for (const [field, info] of Object.entries(result.versionDrift.values || {})) {
      lines.push(`  ${field} = ${info.value} (${info.path})`);
    }
    lines.push("");
  }

  if (result.devCachebusterWarning && result.devCachebusterWarning.detected) {
    lines.push(
      `WARNING: plugins/gateway-codex/.codex-plugin/plugin.json has a dev cachebuster suffix ` +
        `(${result.devCachebusterWarning.version}) — strip it before tagging a release.`
    );
    lines.push("");
  }

  if (result.error) {
    lines.push(`ERROR: ${result.error}`, "");
  }

  for (const h of result.harnesses || []) {
    if (!h.detected) {
      lines.push(`${h.name}  not detected`, "");
      continue;
    }

    lines.push(`${h.name}  detected (${h.cliVersion ?? "unknown version"})`);
    if (h.marketplace) {
      lines.push(
        `  marketplace ${h.marketplace.name} → expected ${h.marketplace.expectedSource}, actual ${
          h.marketplace.actualSource ?? "(not registered)"
        }`
      );
    }
    if (h.action) {
      lines.push(`  plugin action: ${h.action}${h.installedVersionBefore ? ` (was ${h.installedVersionBefore})` : ""}`);
    }
    if (h.error) lines.push(`  error: ${h.error}`);

    for (const cmd of h.commands || []) {
      lines.push(...renderCommandLine(cmd));
    }

    for (const step of h.nextSteps || []) {
      lines.push(`  next: ${step}`);
    }

    lines.push("");
  }

  const s = result.summary || computeSummary(result.harnesses || []);
  lines.push(
    `Summary: ${s.installed} installed, ${s.updated} updated, ${s.unchanged} unchanged, ${s.uninstalled} uninstalled, ${s.failed} failed, ${s.skipped} skipped`
  );

  return lines.join("\n") + "\n";
}

/**
 * Describe why a single state probe (`plugin marketplace list --json` /
 * `plugin list --json`) failed to produce useful output — the diagnostic
 * that `readHarnessState` used to discard entirely (Finding 3 of the final
 * whole-branch review; spec §6.4.1: "si el comando de estado no existe o su
 * salida no parsea: se reporta el fallo con las primeras líneas crudas de
 * la salida — fail loud"). A timeout and a plain non-zero exit are reported
 * with different wording on purpose, so a real hang is never mistaken for
 * malformed JSON. Returns `null` when the probe itself looks clean (exit 0,
 * no stderr) — nothing useful to add for that probe.
 *
 * @param {string} label - e.g. "plugin marketplace list --json"
 * @param {{exitStatus:number|null, stderr:string, timedOut:boolean}} result
 * @param {number} timeoutMs
 * @returns {string|null}
 */
function describeProbeFailure(label, result, timeoutMs) {
  if (!result) return null;
  if (result.timedOut) {
    return `${label} timed out after ${timeoutMs}ms`;
  }
  const stderrText = firstNLines((result.stderr || "").trim(), MATRIX_OUTPUT_MAX_LINES);
  if (stderrText) {
    return `${label} exited ${result.exitStatus} — stderr: ${stderrText}`;
  }
  if (result.exitStatus !== 0) {
    return `${label} exited ${result.exitStatus} with no stderr output`;
  }
  return null;
}

/**
 * Read one harness's install state by actually running its two read-only
 * probe commands (spec §6.4) through `exec`, then handing the captured
 * stdout to the pure parseClaudeState/parseCodexState. A probe that fails
 * to produce parseable JSON (spawn error, non-JSON stdout, etc.) degrades
 * to an empty string here — parseClaudeState/parseCodexState already turn
 * that into `parseError`, which planClaude/planCodex already know how to
 * handle (abort for Claude, degrade for Codex). No new failure mode is
 * invented at this layer.
 *
 * The exec results are also kept (not just their `.stdout`) so that, when
 * parsing does fail, the actual stderr/exitStatus/timedOut can be threaded
 * into that `parseError` (Finding 3: this used to be silently dropped, so a
 * real failure — an old binary without this subcommand, a probe timeout —
 * looked identical to malformed JSON, with no clue why in the user-visible
 * error).
 */
export function readHarnessState(exec, harnessCmd, keys) {
  const marketplaceResult = exec([harnessCmd, "plugin", "marketplace", "list", "--json"], {
    timeoutMs: STATE_TIMEOUT_MS,
  });
  const pluginResult = exec([harnessCmd, "plugin", "list", "--json"], { timeoutMs: STATE_TIMEOUT_MS });

  const stdouts = {
    marketplaceListStdout: marketplaceResult.stdout || "",
    pluginListStdout: pluginResult.stdout || "",
  };
  const state = harnessCmd === "claude" ? parseClaudeState(stdouts, keys) : parseCodexState(stdouts, keys);

  if (!state.parseError) return state;

  const diagnostics = [
    describeProbeFailure("plugin marketplace list --json", marketplaceResult, STATE_TIMEOUT_MS),
    describeProbeFailure("plugin list --json", pluginResult, STATE_TIMEOUT_MS),
  ].filter(Boolean);

  if (diagnostics.length === 0) return state;

  return { ...state, parseError: `${state.parseError} — probe diagnostics: ${diagnostics.join("; ")}` };
}

/**
 * Build one harness's plan entry (detection + manifest + state + the pure
 * planClaude/planCodex output), or the "not detected"/"manifest unreadable"
 * short-circuits that never reach planning. Returns the shape executePlan
 * consumes (`name`, `steps`, `error`) plus everything main()'s final
 * assembly needs to describe the harness regardless of whether it ran.
 */
function buildHarnessPlan({ repoRoot, manifests, detectedEntry, args, exec }) {
  const name = detectedEntry.name;

  if (!detectedEntry.detected) {
    return { name, detected: false, cliVersion: null, manifest: null, state: null, action: null, steps: [], nextSteps: [], error: null, installedVersionBefore: null };
  }

  const manifest = manifests[name];
  if (!manifest || manifest.error) {
    return {
      name,
      detected: true,
      cliVersion: detectedEntry.cliVersion,
      manifest: null,
      state: null,
      action: "blocked",
      steps: [],
      nextSteps: [],
      error: `Could not read this repo's ${name} manifests (${manifest ? manifest.error : "missing manifest block"}).`,
      installedVersionBefore: null,
    };
  }

  const pluginId = `${manifest.pluginName}@${manifest.marketplaceName}`;
  const state = readHarnessState(exec, name, { marketplaceName: manifest.marketplaceName, pluginId });
  const mode = args.uninstall ? "uninstall" : "install";
  const planFn = name === "claude" ? planClaude : planCodex;
  const planInput = { repoRoot, manifest, state, mode, purgeMarketplace: args.purgeMarketplace };
  if (name === "codex") planInput.force = args.force;

  const plan = planFn(planInput);
  return { name, detected: true, cliVersion: detectedEntry.cliVersion, manifest, state, ...plan };
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifests = readRepoManifests(repoRoot);
  const detected = detectHarnesses(args.harnesses);

  // Task 5 built hasDevCachebuster but never wired it in (spec §4 decision
  // 6: "el instalador avisa en cada corrida posterior que el manifest tiene
  // sufijo de dev y hay que limpiarlo antes de release"). Informational
  // only — see the note above buildJson/renderReport.
  const devCachebusterDetected = hasDevCachebuster(manifests.codex.pluginVersion);
  const devCachebusterWarning = {
    detected: devCachebusterDetected,
    version: devCachebusterDetected ? manifests.codex.pluginVersion : null,
  };

  // Must run after detection (codex's presence is only knowable now) and
  // before any planning — rejecting late means we never spend time building
  // plans for a --force that was never going to be valid (Task 4/§9).
  validateForceSelection(args, detected);

  const exec = defaultExec;
  const plans = detected.map((entry) => buildHarnessPlan({ repoRoot, manifests, detectedEntry: entry, args, exec }));

  const executed = executePlan(
    plans.filter((p) => p.detected),
    { exec, dryRun: args.dryRun }
  );
  const executedByName = new Map(executed.map((e) => [e.name, e]));

  const harnesses = plans.map((p) => {
    if (!p.detected) {
      return {
        name: p.name,
        detected: false,
        cliVersion: null,
        action: null,
        installedVersionBefore: null,
        repoVersion: null,
        marketplace: null,
        status: "not-detected",
        hookBlocked: false,
        commands: [],
        nextSteps: [],
        error: null,
      };
    }
    const e = executedByName.get(p.name);
    return {
      name: p.name,
      detected: true,
      cliVersion: p.cliVersion,
      action: p.action,
      installedVersionBefore: p.installedVersionBefore,
      repoVersion: p.manifest ? p.manifest.pluginVersion : null,
      marketplace: p.manifest
        ? { name: p.manifest.marketplaceName, expectedSource: repoRoot, actualSource: p.state ? p.state.marketplaceSource : null }
        : null,
      status: e.status,
      hookBlocked: e.hookBlocked,
      commands: e.commands,
      nextSteps: p.nextSteps,
      error: p.error,
    };
  });

  const result = {
    repoRoot,
    dryRun: args.dryRun,
    uninstall: args.uninstall,
    versionDrift: manifests.drift,
    devCachebusterWarning,
    harnesses,
    error: harnesses.some((h) => h.detected) ? null : NO_HARNESS_DETECTED_ERROR,
  };
  result.summary = computeSummary(harnesses);
  const exitCode = computeExitCode(result);

  if (args.json) {
    process.stdout.write(JSON.stringify(buildJson(result), null, 2) + "\n");
  } else {
    process.stdout.write(renderReport(result));
  }

  process.exitCode = exitCode;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[install-plugins] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
