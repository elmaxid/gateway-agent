import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseRoutingTables, buildRoutingContext, FALLBACK_ROUTING_CONTEXT } from "../plugins/gateway/scripts/lib/routing-index.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseRoutingTables splits a row with escaped pipes into the right columns", () => {
  const md = `## Commands — delegation

| Entry point | What it does | Reach for it when |
|---|---|---|
| \`/gateway:task\` | Delegates one task (\`--harness claude\\|codex\\|zero\\|kimi\\|cline\`) | One bounded task |
`;
  const rows = parseRoutingTables(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entry, "`/gateway:task`");
  assert.equal(rows[0].reachForItWhen, "One bounded task");
});

test("parseRoutingTables excludes a table whose heading says model-invocation is disabled", () => {
  const md = `## Session and job management (type these yourself — model-invocation is disabled)

| Entry point | What it does | Reach for it when |
|---|---|---|
| \`/gateway:status\` | Status of background jobs | A background task is in flight |

## Commands — review

| Entry point | What it does | Reach for it when |
|---|---|---|
| \`/gateway:review\` | Single agentic review pass | Default review before commit |
`;
  const rows = parseRoutingTables(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entry, "`/gateway:review`");
});

test("buildRoutingContext against the real pick-tool skill includes known entries and excludes disabled ones", () => {
  const ctx = buildRoutingContext();
  assert.match(ctx, /\/gateway:review/);
  assert.match(ctx, /Skill\(gateway:spec-plan\)/);
  assert.doesNotMatch(ctx, /\/gateway:status/);
});

test("generated routing index includes the prewalk entry", () => {
  const ctx = buildRoutingContext();
  assert.match(
    ctx,
    /Skill\(gateway:prewalk\)/,
    "The generated session index must route prewalk; otherwise a malformed map row silently removes the skill from discovery"
  );
});

test("prewalk prompts retain the clauses that preserve the two-turn handoff contract", () => {
  const skill = fs.readFileSync(path.join(projectRoot, "plugins/gateway/skills/prewalk/SKILL.md"), "utf8");
  const phase1Start = skill.indexOf("### Phase 1 prompt");
  const phase2Start = skill.indexOf("### Phase 2 prompt");
  const handoffGateStart = skill.indexOf("## Handoff gate");
  const closeOutStart = skill.indexOf("## Close-out");
  const phase1 = skill.slice(phase1Start, handoffGateStart);
  const phase2 = skill.slice(phase2Start, closeOutStart);

  assert.match(
    phase1,
    /PREWALK_READY/,
    "Without the handoff marker, the opener can finish without signaling the orchestrator to perform the phase transition"
  );
  assert.match(
    phase1,
    /Between 3 and 12 items\. Not more\./,
    "Without bounded checklist size, prewalk can be used for an unjustifiably small task or an oversized frozen plan"
  );
  assert.match(
    phase1,
    /TIME-LIMITED INSTRUCTION[\s\S]*?Rule 5 — make one change, then stop — applies to THIS TURN ONLY\./,
    "Without the time-limited stop rule, the opener may either overrun the handoff or cause the closer to stop after one edit"
  );
  assert.match(
    phase2,
    /SUPERSEDES the opening turn's\s+"make exactly ONE change, then stop" rule and its PREWALK_READY handoff marker:/,
    "Without explicit supersession of the named handoff rule, the resumed model may imitate the opener's stop point"
  );
  assert.match(
    phase2,
    /You are not done while any item is unchecked\./,
    "Without the unchecked-item prohibition, the closer may declare success while planned work remains"
  );
});

test("buildRoutingContext falls back to the pointer string when the skill file is missing, and warns on stderr", () => {
  const writeSpy = mock.method(process.stderr, "write", () => true);
  try {
    const ctx = buildRoutingContext({ skillPath: "/nonexistent/path/SKILL.md" });
    assert.equal(ctx, FALLBACK_ROUTING_CONTEXT);
    assert.ok(
      writeSpy.mock.calls.some((c) => c.arguments[0].includes("/nonexistent/path/SKILL.md")),
      "Expected a stderr warning naming the missing path"
    );
  } finally {
    writeSpy.mock.restore();
  }
});

test("buildRoutingContext falls back to the pointer string when no matching tables are found, and warns on stderr", () => {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "routing-index-test-")), "SKILL.md");
  fs.writeFileSync(tmpFile, "# Not a routing map\n\nJust prose, no tables here.\n");

  const writeSpy = mock.method(process.stderr, "write", () => true);
  try {
    const ctx = buildRoutingContext({ skillPath: tmpFile });
    assert.equal(ctx, FALLBACK_ROUTING_CONTEXT);
    assert.ok(
      writeSpy.mock.calls.some((c) => c.arguments[0].includes(tmpFile)),
      "Expected a stderr warning naming the file with no matching tables"
    );
  } finally {
    writeSpy.mock.restore();
  }
});
