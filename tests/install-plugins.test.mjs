import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCliArgs,
  VALID_HARNESSES,
  HELP_TEXT,
  readRepoManifests,
  detectHarnesses,
  parseClaudeState,
  parseCodexState,
} from "../scripts/install-plugins.mjs";
import { captureBinaryVersion } from "../scripts/baseline-capture.mjs";

const DEFAULTS = Object.freeze({
  global: false,
  harnesses: null,
  dryRun: false,
  uninstall: false,
  purgeMarketplace: false,
  force: false,
  json: false,
  help: false,
});

describe("parseCliArgs", () => {
  it("returns the documented defaults when no flags are passed", () => {
    assert.deepStrictEqual(parseCliArgs([]), DEFAULTS);
  });

  it("VALID_HARNESSES is exactly claude and codex (zero is out of scope — no plugin of its own)", () => {
    assert.deepStrictEqual(VALID_HARNESSES, ["claude", "codex"]);
  });

  it("--harness claude,codex and --harness claude --harness codex both produce ['claude','codex'], deduped", () => {
    const commaForm = parseCliArgs(["--harness", "claude,codex"]);
    const repeatedForm = parseCliArgs(["--harness", "claude", "--harness", "codex"]);
    assert.deepStrictEqual(commaForm, { ...DEFAULTS, harnesses: ["claude", "codex"] });
    assert.deepStrictEqual(repeatedForm, { ...DEFAULTS, harnesses: ["claude", "codex"] });
  });

  it("dedupes a harness named twice, whether within one comma list or across repeated flags", () => {
    assert.deepStrictEqual(parseCliArgs(["--harness", "claude,claude"]).harnesses, ["claude"]);
    assert.deepStrictEqual(
      parseCliArgs(["--harness", "claude", "--harness", "claude,codex"]).harnesses,
      ["claude", "codex"]
    );
  });

  it("a single --harness claude produces ['claude'] only", () => {
    assert.deepStrictEqual(parseCliArgs(["--harness", "claude"]), { ...DEFAULTS, harnesses: ["claude"] });
  });

  it("--harness bogus throws, and the message names the valid harnesses", () => {
    assert.throws(
      () => parseCliArgs(["--harness", "bogus"]),
      /Unknown harness "bogus".*Valid harnesses: claude, codex/
    );
  });

  it("--harness with no value throws, naming --harness and the valid options", () => {
    assert.throws(() => parseCliArgs(["--harness"]), /Missing value for --harness/);
    assert.throws(() => parseCliArgs(["--harness"]), /claude, codex/);
  });

  it("-g and --global are accepted as a documented no-op with no other effect", () => {
    const defaults = parseCliArgs([]);
    assert.deepStrictEqual(parseCliArgs(["-g"]), { ...defaults, global: true });
    assert.deepStrictEqual(parseCliArgs(["--global"]), { ...defaults, global: true });
  });

  it("--purge-marketplace without --uninstall throws", () => {
    assert.throws(() => parseCliArgs(["--purge-marketplace"]), /--purge-marketplace requires --uninstall/);
  });

  it("--purge-marketplace combined with --uninstall does not throw, in either flag order", () => {
    assert.deepStrictEqual(parseCliArgs(["--uninstall", "--purge-marketplace"]), {
      ...DEFAULTS,
      uninstall: true,
      purgeMarketplace: true,
    });
    assert.deepStrictEqual(parseCliArgs(["--purge-marketplace", "--uninstall"]), {
      ...DEFAULTS,
      uninstall: true,
      purgeMarketplace: true,
    });
  });

  it("--force --harness claude throws (--force excluding codex is a usage error, not a silent no-op)", () => {
    assert.throws(() => parseCliArgs(["--force", "--harness", "claude"]), /--force only applies to codex/);
  });

  it("--force --harness codex does not throw (codex is in the effective selection)", () => {
    assert.deepStrictEqual(parseCliArgs(["--force", "--harness", "codex"]), {
      ...DEFAULTS,
      force: true,
      harnesses: ["codex"],
    });
  });

  it("--force with no --harness (default = all detected) does not throw here — codex's presence is only known after detection, a later task", () => {
    assert.deepStrictEqual(parseCliArgs(["--force"]), { ...DEFAULTS, force: true });
  });

  it("--force --uninstall throws", () => {
    assert.throws(() => parseCliArgs(["--force", "--uninstall"]), /--force cannot be combined with --uninstall/);
  });

  it("--flag-que-no-existe throws with the offending token in the message", () => {
    assert.throws(() => parseCliArgs(["--flag-que-no-existe"]), /--flag-que-no-existe/);
  });

  it("--dry-run --json --uninstall combine without error", () => {
    assert.deepStrictEqual(parseCliArgs(["--dry-run", "--json", "--uninstall"]), {
      ...DEFAULTS,
      dryRun: true,
      json: true,
      uninstall: true,
    });
  });

  it("-h and --help set help:true without requiring any other flag", () => {
    assert.deepStrictEqual(parseCliArgs(["-h"]), { ...DEFAULTS, help: true });
    assert.deepStrictEqual(parseCliArgs(["--help"]), { ...DEFAULTS, help: true });
  });
});

describe("HELP_TEXT", () => {
  it("documents the zero harness as a static, undetected note pointing at zero-init", () => {
    assert.match(HELP_TEXT, /zero/);
    assert.match(HELP_TEXT, /zero-init/);
  });

  it("points at bootstrap-profiles.mjs for gateway profiles/credentials", () => {
    assert.match(HELP_TEXT, /bootstrap-profiles\.mjs/);
  });

  it("documents every flag from the CLI surface", () => {
    for (const flag of [
      "-g",
      "--global",
      "--harness",
      "--dry-run",
      "--uninstall",
      "--purge-marketplace",
      "--force",
      "--json",
      "-h",
      "--help",
    ]) {
      assert.ok(HELP_TEXT.includes(flag), `HELP_TEXT should mention ${flag}`);
    }
  });
});

describe("readRepoManifests", () => {
  let repoRoot;

  function writeJson(relPath, data) {
    const filePath = path.join(repoRoot, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  // Builds a fixture tree with the same 5 manifests as the real repo. All
  // version fields default to a single aligned value; individual fields
  // can be overridden per test to construct drift.
  function writeFixture({
    packageVersion = "0.5.4",
    pluginVersion = packageVersion,
    marketplaceEntryVersion = packageVersion,
    marketplaceMetaVersion = packageVersion,
    codexPluginVersion = "0.1.0",
  } = {}) {
    writeJson("package.json", { name: "gateway-plugin-cc", version: packageVersion });
    writeJson(".claude-plugin/marketplace.json", {
      name: "agent-gateway",
      metadata: { version: marketplaceMetaVersion },
      plugins: [{ name: "gateway", version: marketplaceEntryVersion, source: "./plugins/gateway" }],
    });
    writeJson("plugins/gateway/.claude-plugin/plugin.json", { name: "gateway", version: pluginVersion });
    writeJson(".agents/plugins/marketplace.json", {
      name: "agent-gateway",
      plugins: [{ name: "gateway-codex", source: { source: "local", path: "./plugins/gateway-codex" } }],
    });
    writeJson("plugins/gateway-codex/.codex-plugin/plugin.json", {
      name: "gateway-codex",
      version: codexPluginVersion,
    });
  }

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "install-plugins-manifests-"));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("reads the real marketplace/plugin names for both harnesses", () => {
    writeFixture();
    const result = readRepoManifests(repoRoot);
    assert.equal(result.claude.marketplaceName, "agent-gateway");
    assert.equal(result.claude.pluginName, "gateway");
    assert.equal(result.codex.marketplaceName, "agent-gateway");
    assert.equal(result.codex.pluginName, "gateway-codex");
  });

  it("reports no drift when all four synced versions agree", () => {
    writeFixture({ packageVersion: "0.5.4" });
    const result = readRepoManifests(repoRoot);
    assert.equal(result.drift.detected, false);
  });

  it("detects drift when plugin.json lags the marketplace entry version, and reports all 4 fields with their paths", () => {
    writeFixture({
      packageVersion: "0.5.4",
      marketplaceEntryVersion: "0.5.4",
      marketplaceMetaVersion: "0.5.4",
      pluginVersion: "0.5.3",
    });
    const result = readRepoManifests(repoRoot);

    assert.equal(result.drift.detected, true);
    assert.equal(result.drift.values.packageVersion.value, "0.5.4");
    assert.equal(result.drift.values.pluginVersion.value, "0.5.3");
    assert.equal(result.drift.values.marketplaceEntryVersion.value, "0.5.4");
    assert.equal(result.drift.values.marketplaceMetaVersion.value, "0.5.4");

    for (const field of [
      "packageVersion",
      "pluginVersion",
      "marketplaceEntryVersion",
      "marketplaceMetaVersion",
    ]) {
      assert.equal(typeof result.drift.values[field].path, "string", `${field} should carry a source path`);
      assert.ok(result.drift.values[field].path.length > 0, `${field} path should be non-empty`);
    }
  });

  it("marks the codex block with an error when its marketplace.json is missing, leaving claude intact", () => {
    writeFixture();
    fs.rmSync(path.join(repoRoot, ".agents/plugins/marketplace.json"));

    const result = readRepoManifests(repoRoot);

    assert.equal(typeof result.codex.error, "string");
    assert.equal(result.codex.marketplaceName, undefined);
    assert.equal(result.claude.error, undefined);
    assert.equal(result.claude.marketplaceName, "agent-gateway");
    assert.equal(result.claude.pluginName, "gateway");
  });

  it("marks the claude block with an error naming the file path when its plugin.json is corrupt JSON", () => {
    writeFixture();
    const pluginPath = path.join(repoRoot, "plugins/gateway/.claude-plugin/plugin.json");
    fs.writeFileSync(pluginPath, "{ not valid json");

    const result = readRepoManifests(repoRoot);

    assert.equal(typeof result.claude.error, "string");
    assert.ok(result.claude.error.includes(pluginPath), "error message should include the offending file path");
    assert.equal(result.codex.error, undefined);

    // Claude manifests unreadable → drift can't be computed from missing
    // data. Must never be silently reported as "no drift".
    assert.equal(result.drift.detected, true);
    assert.equal(typeof result.drift.error, "string");
  });

  it("smoke: reads the real repo's own manifests and finds the real marketplace name in both blocks", () => {
    const realRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = readRepoManifests(realRepoRoot);

    assert.equal(result.claude.marketplaceName, "agent-gateway");
    assert.equal(result.codex.marketplaceName, "agent-gateway");
    assert.equal(result.claude.error, undefined);
    assert.equal(result.codex.error, undefined);
  });
});

describe("detectHarnesses", () => {
  const NOT_FOUND = Object.freeze({ found: false, exitStatus: null, firstLine: null });

  function found(firstLine, exitStatus = 0) {
    return { found: true, exitStatus, firstLine };
  }

  it("neither binary present -> both entries detected:false, no throw", () => {
    const probe = () => NOT_FOUND;
    assert.deepStrictEqual(detectHarnesses(null, { probe }), [
      { name: "claude", detected: false, cliVersion: null },
      { name: "codex", detected: false, cliVersion: null },
    ]);
  });

  it("only claude present", () => {
    const probe = (cmd) => (cmd === "claude" ? found("2.1.3 (Claude Code)") : NOT_FOUND);
    assert.deepStrictEqual(detectHarnesses(null, { probe }), [
      { name: "claude", detected: true, cliVersion: "2.1.3 (Claude Code)" },
      { name: "codex", detected: false, cliVersion: null },
    ]);
  });

  it("only codex present", () => {
    const probe = (cmd) => (cmd === "codex" ? found("codex-cli 0.5.1") : NOT_FOUND);
    assert.deepStrictEqual(detectHarnesses(null, { probe }), [
      { name: "claude", detected: false, cliVersion: null },
      { name: "codex", detected: true, cliVersion: "codex-cli 0.5.1" },
    ]);
  });

  it("both present", () => {
    const probe = (cmd) => found(`${cmd}-version`);
    assert.deepStrictEqual(detectHarnesses(null, { probe }), [
      { name: "claude", detected: true, cliVersion: "claude-version" },
      { name: "codex", detected: true, cliVersion: "codex-version" },
    ]);
  });

  it("explicit --harness codex with codex absent -> throws, naming codex (no silent skip)", () => {
    const probe = () => NOT_FOUND;
    assert.throws(() => detectHarnesses(["codex"], { probe }), /codex/);
  });

  it("explicit --harness codex with codex present -> does not throw and returns only that entry", () => {
    const probe = (cmd) => (cmd === "codex" ? found("0.5.1") : NOT_FOUND);
    assert.deepStrictEqual(detectHarnesses(["codex"], { probe }), [
      { name: "codex", detected: true, cliVersion: "0.5.1" },
    ]);
  });

  it("explicit --harness claude,codex with only codex missing -> throws naming just codex", () => {
    const probe = (cmd) => (cmd === "claude" ? found("2.1.3") : NOT_FOUND);
    assert.throws(() => detectHarnesses(["claude", "codex"], { probe }), /codex/);
  });

  it("smoke: production default probe (captureBinaryVersion, no probe injected) has the right shape", () => {
    const result = detectHarnesses(null);
    assert.equal(result.length, 2);
    for (const entry of result) {
      assert.ok(VALID_HARNESSES.includes(entry.name));
      assert.equal(typeof entry.detected, "boolean");
      assert.ok(entry.cliVersion === null || typeof entry.cliVersion === "string");
    }
  });

  it("smoke: detectHarnesses(selection, {probe: captureBinaryVersion}) matches captureBinaryVersion's own contract", () => {
    const result = detectHarnesses(null, { probe: captureBinaryVersion });
    assert.equal(result.length, 2);
    for (const entry of result) {
      assert.ok(VALID_HARNESSES.includes(entry.name));
      assert.equal(typeof entry.detected, "boolean");
    }
  });
});

describe("parseClaudeState", () => {
  // Verbatim shapes captured live against real `claude` installs in Task 0
  // (docs/superpowers/plans/2026-07-25-harness-installer.md, Task 0 §Paso 2.2/2.3).
  const MARKETPLACE_LIST_STDOUT = JSON.stringify([
    { name: "agent-gateway", source: "directory", path: "/opt/agent-plugin-cc", installLocation: "/opt/agent-plugin-cc" },
  ]);
  const PLUGIN_LIST_STDOUT = JSON.stringify([
    {
      id: "gateway@agent-gateway",
      version: "0.5.2",
      scope: "user",
      enabled: true,
      installPath: "/root/.claude/plugins/cache/agent-gateway/gateway/0.5.2",
      installedAt: "2026-06-08T20:20:57.873Z",
      lastUpdated: "2026-07-20T23:11:47.295Z",
    },
  ]);
  const KEYS = { marketplaceName: "agent-gateway", pluginId: "gateway@agent-gateway" };

  it("extracts installed version and marketplace source from real captured JSON", () => {
    const result = parseClaudeState(
      { marketplaceListStdout: MARKETPLACE_LIST_STDOUT, pluginListStdout: PLUGIN_LIST_STDOUT },
      KEYS
    );
    assert.deepStrictEqual(result, {
      marketplaceRegistered: true,
      marketplaceSource: "/opt/agent-plugin-cc",
      installedVersion: "0.5.2",
      parseError: null,
    });
  });

  it("tolerates version:'unknown' (seen on 3 real plugins in Task 0) without treating it as a parse failure", () => {
    const pluginListStdout = JSON.stringify([{ id: "gateway@agent-gateway", version: "unknown" }]);
    const result = parseClaudeState({ marketplaceListStdout: MARKETPLACE_LIST_STDOUT, pluginListStdout }, KEYS);
    assert.equal(result.installedVersion, "unknown");
    assert.equal(result.parseError, null);
  });

  it("agent-gateway absent from marketplace list -> marketplaceRegistered:false", () => {
    const result = parseClaudeState(
      { marketplaceListStdout: "[]", pluginListStdout: PLUGIN_LIST_STDOUT },
      KEYS
    );
    assert.equal(result.marketplaceRegistered, false);
    assert.equal(result.marketplaceSource, null);
  });

  it("plugin id absent from plugin list -> installedVersion:null (not yet installed)", () => {
    const result = parseClaudeState(
      { marketplaceListStdout: MARKETPLACE_LIST_STDOUT, pluginListStdout: "[]" },
      KEYS
    );
    assert.equal(result.installedVersion, null);
    assert.equal(result.marketplaceRegistered, true);
  });

  it("marketplace source pointing at another path is reported as-is (classification is Task 4's job)", () => {
    const marketplaceListStdout = JSON.stringify([
      { name: "agent-gateway", source: "directory", path: "/some/other/checkout", installLocation: "/some/other/checkout" },
    ]);
    const result = parseClaudeState({ marketplaceListStdout, pluginListStdout: PLUGIN_LIST_STDOUT }, KEYS);
    assert.equal(result.marketplaceRegistered, true);
    assert.equal(result.marketplaceSource, "/some/other/checkout");
  });

  it("non-JSON marketplace list stdout -> parseError set, does not throw", () => {
    let result;
    assert.doesNotThrow(() => {
      result = parseClaudeState(
        { marketplaceListStdout: "not json at all", pluginListStdout: PLUGIN_LIST_STDOUT },
        KEYS
      );
    });
    assert.equal(typeof result.parseError, "string");
    assert.ok(result.parseError.length > 0);
    assert.equal(result.marketplaceRegistered, false);
    assert.equal(result.installedVersion, null);
  });

  it("non-JSON plugin list stdout -> parseError set, does not throw", () => {
    let result;
    assert.doesNotThrow(() => {
      result = parseClaudeState(
        { marketplaceListStdout: MARKETPLACE_LIST_STDOUT, pluginListStdout: "{ not valid" },
        KEYS
      );
    });
    assert.equal(typeof result.parseError, "string");
  });
});

describe("parseCodexState", () => {
  // Verbatim shapes captured live against real `codex` installs in Task 0
  // (docs/superpowers/plans/2026-07-25-harness-installer.md, Task 0 §Paso 2.4).
  const MARKETPLACE_LIST_STDOUT = JSON.stringify({
    marketplaces: [
      { name: "agent-gateway", root: "/opt/agent-plugin-cc", marketplaceSource: { sourceType: "local", source: "/opt/agent-plugin-cc" } },
    ],
  });
  const PLUGIN_LIST_STDOUT = JSON.stringify({
    installed: [
      {
        pluginId: "gateway-codex@agent-gateway",
        name: "gateway-codex",
        marketplaceName: "agent-gateway",
        version: "0.1.0",
        installed: true,
        enabled: true,
        source: { source: "local", path: "/opt/agent-plugin-cc/plugins/gateway-codex" },
        marketplaceSource: { sourceType: "local", source: "/opt/agent-plugin-cc" },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      },
    ],
    available: [],
  });
  const KEYS = { marketplaceName: "agent-gateway", pluginId: "gateway-codex@agent-gateway" };

  it("extracts installed version and marketplace source from real captured JSON", () => {
    const result = parseCodexState(
      { marketplaceListStdout: MARKETPLACE_LIST_STDOUT, pluginListStdout: PLUGIN_LIST_STDOUT },
      KEYS
    );
    assert.deepStrictEqual(result, {
      marketplaceRegistered: true,
      marketplaceSource: "/opt/agent-plugin-cc",
      installedVersion: "0.1.0",
      parseError: null,
    });
  });

  it("agent-gateway absent from marketplace list -> marketplaceRegistered:false", () => {
    const result = parseCodexState(
      { marketplaceListStdout: JSON.stringify({ marketplaces: [] }), pluginListStdout: PLUGIN_LIST_STDOUT },
      KEYS
    );
    assert.equal(result.marketplaceRegistered, false);
    assert.equal(result.marketplaceSource, null);
  });

  it("plugin only in 'available' (offered, not yet installed) -> installedVersion:null even though marketplace is registered", () => {
    const pluginListStdout = JSON.stringify({
      installed: [],
      available: [{ pluginId: "gateway-codex@agent-gateway", name: "gateway-codex", version: "0.1.0" }],
    });
    const result = parseCodexState(
      { marketplaceListStdout: MARKETPLACE_LIST_STDOUT, pluginListStdout },
      KEYS
    );
    assert.equal(result.marketplaceRegistered, true);
    assert.equal(result.installedVersion, null);
  });

  it("marketplace root pointing at another path is reported as-is (classification is Task 4's job)", () => {
    const marketplaceListStdout = JSON.stringify({
      marketplaces: [{ name: "agent-gateway", root: "/some/other/checkout", marketplaceSource: { sourceType: "local", source: "/some/other/checkout" } }],
    });
    const result = parseCodexState({ marketplaceListStdout, pluginListStdout: PLUGIN_LIST_STDOUT }, KEYS);
    assert.equal(result.marketplaceRegistered, true);
    assert.equal(result.marketplaceSource, "/some/other/checkout");
  });

  it("non-JSON marketplace list stdout -> parseError set, does not throw", () => {
    let result;
    assert.doesNotThrow(() => {
      result = parseCodexState(
        { marketplaceListStdout: "not json", pluginListStdout: PLUGIN_LIST_STDOUT },
        KEYS
      );
    });
    assert.equal(typeof result.parseError, "string");
    assert.ok(result.parseError.length > 0);
  });

  it("non-JSON plugin list stdout -> parseError set, does not throw", () => {
    let result;
    assert.doesNotThrow(() => {
      result = parseCodexState(
        { marketplaceListStdout: MARKETPLACE_LIST_STDOUT, pluginListStdout: "{ not valid" },
        KEYS
      );
    });
    assert.equal(typeof result.parseError, "string");
  });
});
