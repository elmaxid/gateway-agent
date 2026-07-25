import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCliArgs, VALID_HARNESSES, HELP_TEXT, readRepoManifests } from "../scripts/install-plugins.mjs";

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
