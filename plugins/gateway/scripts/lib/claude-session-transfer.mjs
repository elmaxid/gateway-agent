import fs from "node:fs";

export function parseTranscript(rawContent) {
  const turns = [];
  for (const line of rawContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }

    const msg = entry.message;
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

    const content = extractTextContent(msg.content);
    if (!content) continue;
    turns.push({ role: msg.role, content });
  }
  return turns;
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image" || block.type === "document") {
      const name = block.name || block.source?.media_type || "file";
      parts.push(`[file: ${name}]`);
    }
    // skip: tool_use, tool_result, thinking, system_reminder
  }
  return parts.join("\n").trim() || null;
}

export function buildMessages(turns, { maxTurns = 30, transferPrompt = "Continue from where we left off." } = {}) {
  const sliced = turns.slice(-maxTurns);
  const systemMsg = {
    role: "system",
    content: `This is a transferred Claude Code session. The last ${sliced.length} turns of context follow.`
  };
  const userMsg = { role: "user", content: transferPrompt };
  return [systemMsg, ...sliced.map(t => ({ role: t.role, content: t.content })), userMsg];
}

export function loadTranscript(transcriptPath) {
  if (!transcriptPath) {
    throw new Error("No transcript path. GATEWAY_TRANSCRIPT_PATH not set. Start a new Claude Code session first.");
  }
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript not found: ${transcriptPath}`);
  }
  return fs.readFileSync(transcriptPath, "utf8");
}
