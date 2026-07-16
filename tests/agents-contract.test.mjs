import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(import.meta.url);
const projectRoot = resolve(testDir, "../..");
const agentsDir = resolve(projectRoot, "plugins/gateway/agents");

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

  it("all agent .md files contain fail-loud contract phrase", async () => {
    const files = await readdir(agentsDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    assert.ok(mdFiles.length > 0, "Expected to find at least one .md file in agents dir");

    for (const file of mdFiles) {
      const filePath = resolve(agentsDir, file);
      const content = await readFile(filePath, "utf-8");
      const hasContract = content.includes(
        "Never convert a gateway failure into an empty response"
      );
      assert.strictEqual(
        hasContract,
        true,
        `Agent ${file} missing fail-loud contract phrase 'Never convert a gateway failure into an empty response'`
      );
    }
  });
});
