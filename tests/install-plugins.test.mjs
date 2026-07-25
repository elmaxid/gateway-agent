import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseCliArgs, VALID_HARNESSES, HELP_TEXT } from "../scripts/install-plugins.mjs";

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
