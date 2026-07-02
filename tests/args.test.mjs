import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateTimeoutOption } from "../plugins/gateway/scripts/lib/args.mjs";

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
