// Declared capability matrix — one entry per gateway harness, five dimensions,
// three states each. This module ONLY declares; it does not validate combos
// or expose a diagnostic command (Task 19) and does not change any runtime
// behavior (existing inline checks in gateway-companion.mjs are untouched).
//
// State meaning:
//   supported   — confirmed by code inspection (a real flag/function exists)
//                 or by a live-verified comment in the harness source.
//   unsupported — confirmed absent: no code path, or an explicit runtime
//                 rejection already in the harness (a structural fact, not
//                 a guess).
//   unknown     — the code path exists but nobody has empirically proven it
//                 does what it claims. A real flag alone does not earn
//                 "supported": readOnly's effect (which tools the harness
//                 allows) is structurally observable in the same code that
//                 sets the flag, while an effect like "does turn 2 see turn
//                 1's context" is not — it can only be shown by actually
//                 running two turns (e.g. codex/kimi resume — empirically
//                 verified 2026-08-25, see
//                 docs/superpowers/plans/2026-08-25-task25-session-identity-investigation.md).
//
// Evidence is per-harness, drawn directly from each adapter file:
//   claude — plugins/gateway/scripts/lib/claude-subprocess.mjs
//   codex  — plugins/gateway/scripts/lib/codex-harness.mjs
//   zero   — plugins/gateway/scripts/lib/zero-harness.mjs
//   kimi   — plugins/gateway/scripts/lib/kimi-harness.mjs
//   cline  — plugins/gateway/scripts/lib/cline-harness.mjs
// and from the existing preflight checks in gateway-companion.mjs.

export const CAPABILITY_STATES = {
  SUPPORTED: "supported",
  UNSUPPORTED: "unsupported",
  UNKNOWN: "unknown",
};

export const HARNESSES = ["claude", "codex", "zero", "kimi", "cline"];

export const HARNESS_CAPABILITIES = {
  claude: {
    // No isClaudeAvailable() exists anywhere in the codebase — unlike the
    // other four, nothing preflights the `claude` binary before spawning it.
    availability: "unsupported",
    // opts.write === false skips the --allowedTools/system-prompt block, but
    // nothing was ever verified to actually block write tool calls in that
    // mode — the canonical "unverified empirically" case (spec Task 18).
    readOnly: "unknown",
    // runClaudeTask has no opts.resume handling at all.
    resume: "unsupported",
    profileKindCompat: {
      // claude-subprocess.mjs and config.mjs's resolveTaskProfile both throw
      // outright for any kind other than "claude-gateway".
      "claude-gateway": "supported",
      "openai-chat": "unsupported",
    },
    // No parse/shape function — --bare stdout is returned as-is, there is
    // nothing to shape.
    outputShape: "unsupported",
  },
  codex: {
    availability: "supported",
    // "-s read-only" is a real codex sandbox flag.
    readOnly: "supported",
    // Task 25 (2026-08-25): verified with a real two-turn round trip.
    // `codex exec resume <thread_id> --json` (explicit thread_id captured
    // from the `thread.started` event, never `--last`) correctly recovers
    // turn 1's context, portable across cwd. Requires the normal (non-resume)
    // turn to run WITHOUT `--ephemeral` — see codex-harness.mjs.
    resume: "supported",
    profileKindCompat: {
      "claude-gateway": "supported",
      // dispatch's own kindCompatible check blesses this explicitly, and a
      // code comment records a live-verified run (2026-08-03).
      "openai-chat": "supported",
    },
    outputShape: "supported",
  },
  zero: {
    availability: "supported",
    // write:false swaps the tool allowlist down to READ_TOOLS only.
    readOnly: "supported",
    // runZeroTask throws "zero harness does not support resume/fork".
    resume: "unsupported",
    profileKindCompat: {
      "claude-gateway": "supported",
      // The adapter itself never checks profile.kind, but dispatch's own
      // kindCompatible gate (gateway-companion.mjs) rejects "openai-chat"
      // for every harness except codex, explicitly and unconditionally —
      // that gate, not the adapter, is the authoritative source here.
      "openai-chat": "unsupported",
    },
    outputShape: "supported",
  },
  kimi: {
    availability: "supported",
    // gateway-companion.mjs rejects --no-write for kimi outright: "no
    // CLI-level read-only mode".
    readOnly: "unsupported",
    // Task 25 (2026-08-25): verified with a real two-turn round trip via
    // `-S <session_id>` (explicit id, captured from the `session.resume_hint`
    // meta event — never the cwd-only `-c`). Correctly recovers turn 1's
    // context, but — verified, not just declared — the session is bound to
    // its originating cwd: kimi itself rejects a resume attempted from
    // elsewhere. Callers must persist and check cwd alongside the id.
    resume: "supported",
    profileKindCompat: {
      "claude-gateway": "supported",
      // Same dispatch gate as zero — rejected unconditionally.
      "openai-chat": "unsupported",
    },
    outputShape: "supported",
  },
  cline: {
    availability: "supported",
    // "--auto-approve false" was verified live, reproduced 3/3 runs (see
    // cline-harness.mjs header comment) — genuinely confirmed, not assumed.
    readOnly: "supported",
    // runClineTask throws "cline harness does not support resume".
    resume: "unsupported",
    profileKindCompat: {
      "claude-gateway": "supported",
      // Same dispatch gate as zero/kimi — rejected unconditionally.
      "openai-chat": "unsupported",
    },
    outputShape: "supported",
  },
};

export function getHarnessCapabilities(harness) {
  const caps = HARNESS_CAPABILITIES[harness];
  if (!caps) throw new Error(`unknown harness "${harness}"`);
  return caps;
}

// Single source of truth for "is this combo impossible" (Task 19), shared by
// both surfaces that queue work (task, dispatch). Only "unsupported" blocks;
// "unknown" must not — it might work, it just hasn't been proven either way.
// Returns null when the combo is fine, or { dimension, ...detail } naming
// which declared capability rejected it, so each caller can render its own
// wording instead of being forced onto one canonical error string.
export function validateHarnessCombo({ harness, profileKind, write, resume }) {
  const caps = getHarnessCapabilities(harness);
  if (write === false && caps.readOnly === "unsupported") {
    return { dimension: "readOnly" };
  }
  // A kind not present in the map at all (malformed config, not one of the
  // two kinds config.mjs's validateProfile allows) defaults to unsupported —
  // same safe-by-default the old allowlist-style check had, just expressed
  // as a lookup instead of an enumeration.
  if (profileKind && (caps.profileKindCompat[profileKind] ?? "unsupported") === "unsupported") {
    return { dimension: "profileKindCompat", profileKind };
  }
  if (resume && caps.resume === "unsupported") {
    return { dimension: "resume" };
  }
  return null;
}
