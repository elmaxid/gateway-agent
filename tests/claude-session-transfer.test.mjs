import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, buildMessages } from "../plugins/gateway/scripts/lib/claude-session-transfer.mjs";

describe("parseTranscript", () => {
  it("extracts user and assistant turns, drops tool_use and tool_result", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
      JSON.stringify({ type: "tool", message: { role: "tool", content: [] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ];
    const turns = parseTranscript(lines.join("\n"));
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].role, "user");
    assert.strictEqual(turns[0].content, "hello");
    assert.strictEqual(turns[1].role, "assistant");
    assert.strictEqual(turns[1].content, "done");
  });

  it("replaces file/image content with placeholder", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: [
        { type: "text", text: "see this" },
        { type: "image", source: { type: "base64", media_type: "image/png" }, name: "screenshot.png" }
      ] } }),
    ];
    const turns = parseTranscript(lines.join("\n"));
    assert.ok(turns[0].content.includes("[file: screenshot.png]") || turns[0].content.includes("[file]"));
  });

  it("skips assistant turns with only tool_use content (no text)", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } }),
    ];
    const turns = parseTranscript(lines.join("\n"));
    assert.strictEqual(turns.length, 0);
  });

  it("skips user turns whose content is only tool_result blocks (no text)", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "output" }] }
      ] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "real question" }] } }),
    ];
    const turns = parseTranscript(lines.join("\n"));
    assert.strictEqual(turns.length, 1, "tool_result-only user turn should be dropped");
    assert.strictEqual(turns[0].content, "real question");
  });

  it("handles non-string block.text gracefully", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: [
        { type: "text", text: null },
        { type: "text", text: 42 },
        { type: "text", text: "valid text" }
      ] } }),
    ];
    const turns = parseTranscript(lines.join("\n"));
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].content, "valid text");
  });
});

describe("buildMessages", () => {
  it("truncates to last N turns and prepends system message", () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`
    }));
    const messages = buildMessages(turns, { maxTurns: 10, transferPrompt: "Continue." });
    assert.strictEqual(messages[0].role, "system");
    assert.ok(messages[0].content.includes("transferred Claude Code session"));
    // last 10 turns + system + final user prompt
    assert.strictEqual(messages.length, 12);
    assert.strictEqual(messages[messages.length - 1].role, "user");
    assert.strictEqual(messages[messages.length - 1].content, "Continue.");
  });

  it("merges consecutive same-role turns", () => {
    const turns = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },  // consecutive assistant
      { role: "user", content: "q2" },
    ];
    const messages = buildMessages(turns, { maxTurns: 10, transferPrompt: "Go." });
    // system + merged(user, assistant, user-with-prompt)
    // assistant a1+a2 merged, user q2 gets "Go." appended
    const roles = messages.map(m => m.role);
    assert.deepStrictEqual(roles, ["system", "user", "assistant", "user"]);
    assert.ok(messages[2].content.includes("a1"));
    assert.ok(messages[2].content.includes("a2"));
  });

  it("appends transferPrompt to trailing user turn instead of adding duplicate", () => {
    const turns = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "last question" },
    ];
    const messages = buildMessages(turns, { maxTurns: 10, transferPrompt: "Continue." });
    const roles = messages.map(m => m.role);
    // No consecutive user messages
    assert.deepStrictEqual(roles, ["system", "user", "assistant", "user"]);
    // Last user message has both original content and transferPrompt
    const lastMsg = messages[messages.length - 1];
    assert.ok(lastMsg.content.includes("last question"));
    assert.ok(lastMsg.content.includes("Continue."));
  });

  it("handles empty turns array", () => {
    const messages = buildMessages([], { maxTurns: 10, transferPrompt: "Start." });
    assert.strictEqual(messages.length, 2); // system + user prompt
    assert.strictEqual(messages[0].role, "system");
    assert.strictEqual(messages[1].role, "user");
    assert.strictEqual(messages[1].content, "Start.");
  });
});
