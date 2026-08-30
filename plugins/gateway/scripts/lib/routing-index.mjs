import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SKILL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../skills/pick-tool/SKILL.md"
);

export const FALLBACK_ROUTING_CONTEXT = `<gateway-routing-rules>
Gateway plugin active. Invoke Skill(gateway:pick-tool) for the full routing map. Run /gateway:setup to see configured profiles and endpoints.
</gateway-routing-rules>`;

const DISABLED_HEADING_MARKER = "model-invocation is disabled";
const TABLE_HEADER = "| Entry point | What it does | Reach for it when |";

function splitUnescapedPipes(row) {
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

export function parseRoutingTables(markdown) {
  const rows = [];
  let currentHeadingDisabled = false;
  let inTargetTable = false;

  for (const line of markdown.split("\n")) {
    if (line.startsWith("#")) {
      currentHeadingDisabled = line.includes(DISABLED_HEADING_MARKER);
      inTargetTable = false;
      continue;
    }

    if (line.trim() === TABLE_HEADER) {
      inTargetTable = !currentHeadingDisabled;
      continue;
    }

    if (!inTargetTable) continue;

    if (/^\|\s*-+\s*\|/.test(line)) continue; // separator row
    if (!line.startsWith("|")) {
      inTargetTable = false;
      continue;
    }

    const cells = splitUnescapedPipes(line).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    if (cells.length !== 3) continue;

    rows.push({ entry: cells[0], reachForItWhen: cells[2] });
  }

  return rows;
}

function formatRoutingContext(rows) {
  const bullets = rows.map((r) => `- ${r.entry} — ${r.reachForItWhen}`).join("\n");
  return `<gateway-routing-rules>
Gateway plugin active. Quick routing index (full map + disambiguation: Skill(gateway:pick-tool)):
${bullets}
Run /gateway:setup to see configured profiles and endpoints.
</gateway-routing-rules>`;
}

export function buildRoutingContext({ skillPath = DEFAULT_SKILL_PATH } = {}) {
  try {
    const markdown = fs.readFileSync(skillPath, "utf8");
    const rows = parseRoutingTables(markdown);
    if (rows.length === 0) {
      process.stderr.write(`[routing-index] warning: no routing tables found in ${skillPath}, falling back\n`);
      return FALLBACK_ROUTING_CONTEXT;
    }
    return formatRoutingContext(rows);
  } catch (err) {
    process.stderr.write(`[routing-index] warning: failed to read/parse ${skillPath}: ${err.message}, falling back\n`);
    return FALLBACK_ROUTING_CONTEXT;
  }
}
