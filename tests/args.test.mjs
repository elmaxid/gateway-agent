import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, validateTimeoutOption } from "../plugins/gateway/scripts/lib/args.mjs";

describe("parseArgs value options", () => {
  const config = {
    valueOptions: ["model"],
    booleanOptions: ["no-write"],
    aliasMap: { m: "model" }
  };

  it("rejects a long value option followed by another option", () => {
    assert.throws(
      () => parseArgs(["--model", "--no-write", "prompt"], config),
      /Missing value for --model/
    );
  });

  it("rejects a short value-option alias followed by another option", () => {
    assert.throws(
      () => parseArgs(["-m", "--no-write", "prompt"], config), /Missing value for -m/);
  });

  it("accepts inline values that begin with a dash", () => {
    assert.deepStrictEqual(parseArgs(["--model=--local"], config), {
      options: { model: "--local" },
      positionals: []
    });
  });

  it("treats every token after -- as a positional", () => {
    assert.deepStrictEqual(parseArgs(["--", "--model", "--no-write"], config), {
      options: {},
      positionals: ["--model", "--no-write"]
    });
  });

  it("does not let -- satisfy a preceding value option", () => {
    assert.throws(() => parseArgs(["--model", "--", "--local"], config), /Missing value for --model/);
  });
});

describe("validateTimeoutOption", () => {
  it("returns undefined when rawValue is undefined (no-op, flag not passed)", () => {
    assert.strictEqual(validateTimeoutOption(undefined), undefined);
  });

  it("returns the numeric value for a valid mid-range input", () => {
    assert.strictEqual(validateTimeoutOption("5000"), 5000);
  });

  it("throws for 0", () => {
    assert.throws(() => validateTimeoutOption("0"), /Invalid --timeout "0"/);
  });

  it("throws for a negative value", () => {
    assert.throws(() => validateTimeoutOption("-100"), /Invalid --timeout "-100"/);
  });

  it('throws for a non-numeric string ("abc" -> NaN)', () => {
    assert.throws(() => validateTimeoutOption("abc"), /Invalid --timeout "abc"/);
  });

  it("throws for Infinity", () => {
    assert.throws(() => validateTimeoutOption("Infinity"), /Invalid --timeout "Infinity"/);
  });

  it("accepts the exact boundary value 2147483647 (2^31 - 1, Node's setTimeout limit)", () => {
    assert.strictEqual(validateTimeoutOption("2147483647"), 2147483647);
  });

  it("throws for boundary + 1 (2147483648) since it would overflow setTimeout", () => {
    assert.throws(() => validateTimeoutOption("2147483648"), /Invalid --timeout "2147483648"/);
  });

  it("pins the exact error message text so wording can't drift silently", () => {
    let err;
    try {
      validateTimeoutOption("abc");
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected validateTimeoutOption to throw");
    assert.strictEqual(
      err.message,
      'Invalid --timeout "abc". Expected a positive number of milliseconds (max 2147483647).'
    );
  });

  it("uses the custom flagName in both the option name and the error message", () => {
    let err;
    try {
      validateTimeoutOption("abc", "max-concurrency");
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected validateTimeoutOption to throw");
    assert.strictEqual(
      err.message,
      'Invalid --max-concurrency "abc". Expected a positive number of milliseconds (max 2147483647).'
    );
  });
});

it("a value option refusing an option token names the offending token", () => {
  const cfg = { valueOptions: ["model"], booleanOptions: ["no-write"], aliasMap: { m: "model" } };

  // The point of naming the token: the operator typed --no-write on purpose. Telling them
  // "missing value" alone sends them looking for a value they never meant to omit.
  assert.throws(
    () => parseArgs(["--model", "--no-write", "prompt"], cfg),
    /next token "--no-write" is another option/
  );
  assert.throws(() => parseArgs(["--model", "--no-write"], cfg), /--model=<value>/);

  // The short branch has no inline form at all (`-m=x` falls through to positionals), so its
  // message must not advertise one — advertising it would send the operator into silent failure.
  let shortErr;
  try { parseArgs(["-m", "--no-write"], cfg); } catch (err) { shortErr = err; }
  assert.ok(shortErr, "expected the short alias to reject an option token as its value");
  assert.match(shortErr.message, /next token "--no-write" is another option/);
  assert.ok(!shortErr.message.includes("="), `short-option message must not offer an inline form: ${shortErr.message}`);
});

describe("parseArgs rejects unknown options", () => {
  const config = {
    valueOptions: ["model"],
    booleanOptions: ["no-write"],
    aliasMap: { m: "model" }
  };

  it("throws on an unrecognized long option", () => {
    assert.throws(
      () => parseArgs(["--totally-bogus"], config),
      /Unknown option "--totally-bogus"/
    );
  });

  it("names the offending token verbatim in the long-option error", () => {
    let err;
    try {
      parseArgs(["--totally-bogus"], config);
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected parseArgs to throw");
    assert.strictEqual(err.message, 'Unknown option "--totally-bogus".');
  });

  it("throws on an unrecognized short option", () => {
    assert.throws(
      () => parseArgs(["-z"], config),
      /Unknown option "-z"/
    );
  });

  it("names the offending token verbatim in the short-option error", () => {
    let err;
    try {
      parseArgs(["-z"], config);
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected parseArgs to throw");
    assert.strictEqual(err.message, 'Unknown option "-z".');
  });

  it("treats an unrecognized option after -- as a positional (separator guard)", () => {
    assert.deepStrictEqual(parseArgs(["--", "--totally-bogus"], config), {
      options: {},
      positionals: ["--totally-bogus"]
    });
  });

  it("still rejects an unrecognized option that appears before --", () => {
    assert.throws(
      () => parseArgs(["--totally-bogus", "--", "x"], config),
      /Unknown option "--totally-bogus"/
    );
  });
});
