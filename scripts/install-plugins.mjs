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
// Usage (once fully implemented — see status note below):
//   node scripts/install-plugins.mjs             # install/update everything detected
//   node scripts/install-plugins.mjs --dry-run   # print the plan, mutate nothing
//   node scripts/install-plugins.mjs --help      # full flag reference
//
// Implementation status: this file currently implements CLI argument
// parsing (`parseCliArgs`, `--help` text — Task 1) and manifest reading +
// version drift detection (`readRepoManifests` — Task 2). Harness
// detection, planning, and execution land in Tasks 3-6 of that plan.
// Running this script today parses its args and, with `-h`/`--help`,
// prints usage; it does not yet install or update anything — that's a
// deliberate scope boundary for this task, not a bug.
//
// Style precedent: same pattern as scripts/make-build-info.mjs and
// scripts/baseline-capture.mjs — ESM, node:* builtins only, and a main()
// guarded by comparing process.argv[1] against this module's URL so the
// file is importable from tests without side effects.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  // Harness detection, planning, and execution are added in Tasks 3-6 of
  // docs/superpowers/plans/2026-07-25-harness-installer.md.
  // readRepoManifests (Task 2) is implemented but not yet wired in here —
  // that's Task 3+'s job. Nothing else happens yet — see the
  // "Implementation status" note above.
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
