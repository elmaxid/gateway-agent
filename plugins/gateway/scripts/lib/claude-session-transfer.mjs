import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    if (block.type === "text" && typeof block.text === "string") {
      const t = block.text.trim();
      if (t.startsWith('<local-command-') || t.startsWith('<command-name>') ||
          t.startsWith('<command-message>') || t.startsWith('<command-args>')) {
        continue;
      }
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

  // Merge consecutive same-role turns (created by filtering tool_use-only entries)
  const merged = [];
  for (const turn of sliced) {
    if (merged.length > 0 && merged[merged.length - 1].role === turn.role) {
      merged[merged.length - 1].content += "\n\n" + turn.content;
    } else {
      merged.push({ role: turn.role, content: turn.content });
    }
  }

  const systemMsg = {
    role: "system",
    content: `This is a transferred Claude Code session. The last ${merged.length} turns of context follow.`
  };

  // If last turn is already user, append transferPrompt to it instead of creating consecutive user messages
  if (merged.length > 0 && merged[merged.length - 1].role === "user") {
    merged[merged.length - 1].content += "\n\n" + transferPrompt;
    return [systemMsg, ...merged];
  }

  return [systemMsg, ...merged, { role: "user", content: transferPrompt }];
}

export function loadTranscript(transcriptPath) {
  if (!transcriptPath) {
    throw new Error("No transcript path. GATEWAY_TRANSCRIPT_PATH not set. Start a new Claude Code session first.");
  }
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript not found: ${transcriptPath}`);
  }
  if (!transcriptPath.endsWith(".jsonl")) {
    throw new Error(`Invalid transcript path (must be .jsonl): ${transcriptPath}`);
  }
  const realPath = fs.realpathSync(transcriptPath);
  const claudeDir = path.join(os.homedir(), ".claude");
  if (!realPath.startsWith(claudeDir + path.sep) && !realPath.startsWith(claudeDir + "/")) {
    throw new Error(`Transcript path must be under ~/.claude/: ${transcriptPath}`);
  }
  return fs.readFileSync(transcriptPath, "utf8");
}
