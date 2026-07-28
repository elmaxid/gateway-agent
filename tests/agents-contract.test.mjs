import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(import.meta.url);
const projectRoot = resolve(testDir, "../..");
const agentsDir = resolve(projectRoot, "plugins/gateway/agents");
const skillsDir = resolve(projectRoot, "plugins/gateway/skills");

describe("agents error contract", () => {
  it("no agent .md contains 'return nothing' (anti-pattern)", async () => {
    const files = await readdir(agentsDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    assert.ok(mdFiles.length > 0, "Expected to find at least one .md file in agents dir");

    for (const file of mdFiles) {
      const filePath = resolve(agentsDir, file);
      const content = await readFile(filePath, "utf-8");
      const hasAntiPattern = /return nothing/i.test(content);
      assert.strictEqual(
        hasAntiPattern,
        false,
        `Agent ${file} contains 'return nothing' anti-pattern — must be removed`
      );
    }
  });

  it("every gateway-forwarding agent (tools: Bash) contains the fail-loud contract phrase", async () => {
    const files = await readdir(agentsDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    assert.ok(mdFiles.length > 0, "Expected to find at least one .md file in agents dir");

    // Only agents that can actually shell out to gateway-companion.mjs (tools:
    // Bash) can have "a gateway failure" to swallow — native-only agents (e.g.
    // research-planner: Read/Grep/Glob/WebSearch/WebFetch/Write, no Bash, never
    // touches the gateway) are exempt from a contract phrase that wouldn't be true.
    let checked = 0;
    for (const file of mdFiles) {
      const filePath = resolve(agentsDir, file);
      const content = await readFile(filePath, "utf-8");
      const toolsMatch = content.match(/^tools:\s*(.+)$/m);
      const usesBash = toolsMatch ? /\bBash\b/.test(toolsMatch[1]) : false;
      if (!usesBash) continue;
      checked += 1;
      const hasContract = content.includes(
        "Never convert a gateway failure into an empty response"
      );
      assert.strictEqual(
        hasContract,
        true,
        `Agent ${file} missing fail-loud contract phrase 'Never convert a gateway failure into an empty response'`
      );
    }
    assert.ok(checked > 0, "Expected at least one Bash-tool (gateway-forwarding) agent to check");
  });
});

describe("skills error contract", () => {
  it("no skill .md contains 'return nothing' (anti-pattern)", async () => {
    // Forwarder subagents consult these skills; a 'return nothing' instruction
    // there would silently swallow a real gateway failure, contradicting the
    // fail-loud contract every agent .md carries. Scan the whole skills tree.
    const entries = await readdir(skillsDir, { recursive: true });
    const mdFiles = entries.filter((f) => f.endsWith(".md"));

    assert.ok(mdFiles.length > 0, "Expected to find at least one .md file in skills dir");

    for (const rel of mdFiles) {
      const filePath = resolve(skillsDir, rel);
      const content = await readFile(filePath, "utf-8");
      const hasAntiPattern = /return nothing/i.test(content);
      assert.strictEqual(
        hasAntiPattern,
        false,
        `Skill ${rel} contains 'return nothing' anti-pattern — must be removed`
      );
    }
  });
});
