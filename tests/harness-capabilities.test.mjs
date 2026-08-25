import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_STATES,
  HARNESSES,
  HARNESS_CAPABILITIES,
  getHarnessCapabilities,
  validateHarnessCombo,
} from "../plugins/gateway/scripts/lib/harness-capabilities.mjs";

test("CAPABILITY_STATES has exactly the three declared states", () => {
  assert.deepEqual(Object.values(CAPABILITY_STATES).sort(), ["supported", "unknown", "unsupported"]);
});

test("HARNESSES lists all five gateway harnesses", () => {
  assert.deepEqual([...HARNESSES].sort(), ["claude", "cline", "codex", "kimi", "zero"]);
});

test("every harness declares all five capability dimensions", () => {
  for (const harness of HARNESSES) {
    const caps = HARNESS_CAPABILITIES[harness];
    assert.ok(caps, `missing capability entry for "${harness}"`);
    for (const dim of ["availability", "readOnly", "resume", "profileKindCompat", "outputShape"]) {
      assert.ok(dim in caps, `"${harness}" missing dimension "${dim}"`);
    }
  }
});

test("every flat dimension value is one of the three declared states", () => {
  const validStates = new Set(Object.values(CAPABILITY_STATES));
  for (const harness of HARNESSES) {
    const caps = HARNESS_CAPABILITIES[harness];
    for (const dim of ["availability", "readOnly", "resume", "outputShape"]) {
      assert.ok(validStates.has(caps[dim]), `"${harness}".${dim} = "${caps[dim]}" is not a valid state`);
    }
  }
});

test("profileKindCompat is a map of claude-gateway/openai-chat to a valid state", () => {
  const validStates = new Set(Object.values(CAPABILITY_STATES));
  for (const harness of HARNESSES) {
    const compat = HARNESS_CAPABILITIES[harness].profileKindCompat;
    assert.deepEqual(Object.keys(compat).sort(), ["claude-gateway", "openai-chat"]);
    for (const kind of ["claude-gateway", "openai-chat"]) {
      assert.ok(validStates.has(compat[kind]), `"${harness}".profileKindCompat.${kind} = "${compat[kind]}" is not a valid state`);
    }
  }
});

// Availability: claude has no isXAvailable() check in the codebase (structural
// fact, not empirical) — the other four each ship one (isCodexAvailable,
// isZeroAvailable, isKimiAvailable, isClineAvailable).
test("availability: claude unsupported (no check exists), others supported", () => {
  assert.equal(HARNESS_CAPABILITIES.claude.availability, "unsupported");
  for (const harness of ["codex", "zero", "kimi", "cline"]) {
    assert.equal(HARNESS_CAPABILITIES[harness].availability, "supported");
  }
});

// Read-only mode: codex has a real "-s read-only" sandbox flag, zero swaps to
// READ_TOOLS only, cline's "--auto-approve false" was verified live 3/3 runs
// (see cline-harness.mjs comment) — all structurally/empirically confirmed.
// kimi rejects --no-write outright (gateway-companion.mjs: "no CLI-level
// read-only mode"). claude's write:false path exists but was never verified
// to actually block writes (spec: this is the canonical "unknown" example).
test("readOnly: claude unknown, kimi unsupported, others supported", () => {
  assert.equal(HARNESS_CAPABILITIES.claude.readOnly, "unknown");
  assert.equal(HARNESS_CAPABILITIES.kimi.readOnly, "unsupported");
  for (const harness of ["codex", "zero", "cline"]) {
    assert.equal(HARNESS_CAPABILITIES[harness].readOnly, "supported");
  }
});

// Resume: claude-subprocess has no resume code path at all (unsupported,
// structural). zero and cline throw explicitly at runtime ("does not support
// resume/fork" / "resume is rejected") — unsupported, structural. codex
// (explicit thread_id) and kimi (explicit session_id) were empirically
// verified in Task 25 (2026-08-25) with a real two-turn round trip — supported.
test("resume: claude/zero/cline unsupported, codex/kimi supported (Task 25)", () => {
  for (const harness of ["claude", "zero", "cline"]) {
    assert.equal(HARNESS_CAPABILITIES[harness].resume, "unsupported");
  }
  for (const harness of ["codex", "kimi"]) {
    assert.equal(HARNESS_CAPABILITIES[harness].resume, "supported");
  }
});

// Profile kind compatibility: claude-subprocess.mjs hard-rejects any kind
// other than "claude-gateway" (config.mjs + claude-subprocess.mjs both
// throw). dispatch's own kindCompatible gate (gateway-companion.mjs) is the
// authoritative source for the rest: it accepts "openai-chat" only when
// harness === "codex", and rejects it unconditionally for every other
// harness — including zero/kimi/cline, whose adapters never check kind
// themselves but are still blocked by that gate before they'd ever run.
test("profileKindCompat: claude-gateway supported everywhere, openai-chat only codex", () => {
  for (const harness of HARNESSES) {
    assert.equal(HARNESS_CAPABILITIES[harness].profileKindCompat["claude-gateway"], "supported");
  }
  assert.equal(HARNESS_CAPABILITIES.codex.profileKindCompat["openai-chat"], "supported");
  for (const harness of ["claude", "zero", "kimi", "cline"]) {
    assert.equal(HARNESS_CAPABILITIES[harness].profileKindCompat["openai-chat"], "unsupported");
  }
});

// Output shape: does this harness extract a final message from an
// event-stream, preserving the raw stream separately (rawJsonl)? claude-
// subprocess has no parse/shape function — it returns raw --bare stdout
// as-is, there is nothing to shape. The other four each ship a
// parseXStream/shapeXResult pair.
test("outputShape: claude unsupported (nothing to shape), others supported", () => {
  assert.equal(HARNESS_CAPABILITIES.claude.outputShape, "unsupported");
  for (const harness of ["codex", "zero", "kimi", "cline"]) {
    assert.equal(HARNESS_CAPABILITIES[harness].outputShape, "supported");
  }
});

test("getHarnessCapabilities returns the same object as the table, and throws on unknown harness", () => {
  for (const harness of HARNESSES) {
    assert.deepEqual(getHarnessCapabilities(harness), HARNESS_CAPABILITIES[harness]);
  }
  assert.throws(() => getHarnessCapabilities("nope"), /unknown harness/i);
});

// Task 19: single source of truth for "is this combo impossible", shared by
// both dispatching surfaces (task and dispatch). Only "unsupported" blocks —
// "unknown" (e.g. claude's readOnly) must NOT block, since it might work.
test("validateHarnessCombo: blocks kimi --no-write (readOnly unsupported)", () => {
  assert.deepEqual(validateHarnessCombo({ harness: "kimi", write: false }), { dimension: "readOnly" });
});

test("validateHarnessCombo: does not block --no-write for claude (unknown, not unsupported)", () => {
  assert.equal(validateHarnessCombo({ harness: "claude", write: false }), null);
});

test("validateHarnessCombo: does not block --no-write for codex/zero/cline (readOnly supported)", () => {
  for (const harness of ["codex", "zero", "cline"]) {
    assert.equal(validateHarnessCombo({ harness, write: false }), null);
  }
});

test("validateHarnessCombo: write:true or write:undefined never triggers readOnly block", () => {
  assert.equal(validateHarnessCombo({ harness: "kimi", write: true }), null);
  assert.equal(validateHarnessCombo({ harness: "kimi" }), null);
});

test("validateHarnessCombo: blocks openai-chat for claude/zero/kimi/cline (profileKindCompat unsupported)", () => {
  for (const harness of ["claude", "zero", "kimi", "cline"]) {
    assert.deepEqual(
      validateHarnessCombo({ harness, profileKind: "openai-chat" }),
      { dimension: "profileKindCompat", profileKind: "openai-chat" }
    );
  }
});

test("validateHarnessCombo: allows openai-chat for codex", () => {
  assert.equal(validateHarnessCombo({ harness: "codex", profileKind: "openai-chat" }), null);
});

test("validateHarnessCombo: allows claude-gateway for every harness", () => {
  for (const harness of HARNESSES) {
    assert.equal(validateHarnessCombo({ harness, profileKind: "claude-gateway" }), null);
  }
});

test("validateHarnessCombo: no profileKind given skips that check", () => {
  assert.equal(validateHarnessCombo({ harness: "zero" }), null);
});

test("validateHarnessCombo: readOnly violation reported before profileKindCompat when both apply", () => {
  assert.deepEqual(
    validateHarnessCombo({ harness: "kimi", write: false, profileKind: "openai-chat" }),
    { dimension: "readOnly" }
  );
});

test("validateHarnessCombo: blocks a profile kind that isn't claude-gateway or openai-chat at all (malformed config)", () => {
  for (const harness of HARNESSES) {
    assert.deepEqual(
      validateHarnessCombo({ harness, profileKind: "openai" }),
      { dimension: "profileKindCompat", profileKind: "openai" }
    );
  }
});

test("validateHarnessCombo: throws on unknown harness (same as getHarnessCapabilities)", () => {
  assert.throws(() => validateHarnessCombo({ harness: "nope" }), /unknown harness/i);
});

// Task 26: --resume must be rejected before ever reaching a harness that
// structurally can't do it (claude/zero/cline), and allowed through for
// codex/kimi (Task 25-verified).
test("validateHarnessCombo: resume:true blocks claude/zero/cline (resume unsupported)", () => {
  for (const harness of ["claude", "zero", "cline"]) {
    assert.deepEqual(validateHarnessCombo({ harness, resume: true }), { dimension: "resume" });
  }
});

test("validateHarnessCombo: resume:true allows codex/kimi (resume supported)", () => {
  for (const harness of ["codex", "kimi"]) {
    assert.equal(validateHarnessCombo({ harness, resume: true }), null);
  }
});

test("validateHarnessCombo: resume:false/undefined never triggers the resume block, even for zero", () => {
  assert.equal(validateHarnessCombo({ harness: "zero", resume: false }), null);
  assert.equal(validateHarnessCombo({ harness: "zero" }), null);
});
