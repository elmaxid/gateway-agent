// ---------------------------------------------------------------------------
// Structured error redaction.
//
// Single responsibility: turn raw error material (messages, subprocess stderr)
// into output that is safe to show a user or agent, while preserving the full
// unredacted detail in a local 0600 log for diagnosis.
//
// Intentionally free of job-control / tracked-jobs / state dependencies — only
// depends on config.mjs for the default log directory location (Task A4 will
// consume this lib; keep it dependency-light to avoid import cycles).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_PATH } from "./config.mjs";

const DEFAULT_MAX_LINES = 50;

/**
 * Collect the literal secret values (apiKey / authToken) from every configured
 * profile. These are the concrete strings we scrub from any user/agent-facing
 * text.
 * @param {{profiles?: Record<string, object>}} config parsed gateway config
 * @returns {string[]} unique, non-empty secret strings
 */
export function collectConfigSecrets(config) {
  const secrets = new Set();
  const profiles = config?.profiles;
  if (profiles && typeof profiles === "object") {
    for (const profile of Object.values(profiles)) {
      if (!profile || typeof profile !== "object") continue;
      for (const key of ["apiKey", "authToken"]) {
        const val = profile[key];
        if (typeof val === "string" && val.length > 0) secrets.add(val);
      }
    }
  }
  return [...secrets];
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact sensitive material from a text blob. Covers, in order:
 *  - `Bearer <token>` headers (preserves prior sanitizeError behavior).
 *  - Each literal config secret (regex-escaped) → `[REDACTED]`.
 *  - Credentials embedded in URLs: `scheme://user:pass@host` → `scheme://[REDACTED]@host`.
 *  - URL query strings: the `?query` of a `scheme://host[/path]?query` token →
 *    `?[REDACTED]` (gateway endpoints never need the query for diagnosis). The
 *    rule is anchored to URL context so a bare `?` in prose/code — optional
 *    chaining (`foo?.bar`), ternaries (`x ? y : z`), regex literals — is left
 *    intact, keeping streamed model output readable in job logs / status.
 * @param {string} text
 * @param {string[]} [secrets] literal secrets to scrub (e.g. collectConfigSecrets)
 * @returns {string}
 */
export function redactText(text, secrets = []) {
  if (typeof text !== "string" || text.length === 0) return text ?? "";
  let out = text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  // Longest-first so a secret that is a prefix of another can't leave a tail exposed.
  const sorted = [...new Set(secrets.filter((s) => typeof s === "string" && s.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g, "$1[REDACTED]@");
  // Only redact a query string that belongs to a URL (scheme://host[/path]?query),
  // not any stray `?` in prose/code.
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s?#]+)\?[^\s#]+/g, "$1?[REDACTED]");
  return out;
}

/**
 * Bound multi-line text to at most `maxLines`, appending a marker that records
 * how many lines were dropped.
 * @param {string} text
 * @param {{maxLines?: number}} [opts]
 * @returns {string}
 */
export function truncateOutput(text, { maxLines = DEFAULT_MAX_LINES } = {}) {
  if (typeof text !== "string" || text.length === 0) return text ?? "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const omitted = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join("\n")}\n[... ${omitted} lines omitted]`;
}

function defaultLogDir() {
  return path.join(path.dirname(CONFIG_PATH), "logs");
}

function formatLogBody(input) {
  const parts = [`timestamp: ${new Date().toISOString()}`];
  if (input.context) parts.push(`context: ${input.context}`);
  if (Number.isInteger(input.exitCode)) parts.push(`exitCode: ${input.exitCode}`);
  parts.push("", "message:", String(input.message ?? ""));
  if (input.stderr) parts.push("", "stderr:", String(input.stderr));
  return parts.join("\n") + "\n";
}

/**
 * Write the FULL, UNREDACTED detail to a local 0600 log file. Best-effort:
 * never throws — returns the path on success, or null if the write failed.
 */
function writeLocalLog(input, logDir) {
  try {
    const dir = logDir || defaultLogDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `error-${Date.now()}-${randomBytes(6).toString("hex")}.log`);
    fs.writeFileSync(file, formatLogBody(input), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  } catch {
    return null;
  }
}

/**
 * Build the three-level error contract.
 *  - `userMessage`   — safe for user/agent: first redacted line + exit code, no stderr.
 *  - `operatorDetail`— sanitized technical detail: redacted message + redacted,
 *    line-bounded stderr.
 *  - `localLogPath`  — full unredacted detail on disk (0600), or null if the
 *    write failed. Never throws from here.
 * @param {{message?: string, stderr?: string, exitCode?: number, context?: string}} input
 * @param {{secrets?: string[], logDir?: string}} [opts]
 * @returns {{userMessage: string, operatorDetail: string, localLogPath: string|null}}
 */
export function buildStructuredError(input = {}, { secrets = [], logDir } = {}) {
  const message = typeof input.message === "string" ? input.message : String(input.message ?? "");
  const stderr = typeof input.stderr === "string" ? input.stderr : "";
  const hasExit = Number.isInteger(input.exitCode);

  const redactedMessage = redactText(message, secrets);
  const redactedStderr = truncateOutput(redactText(stderr, secrets)).trim();

  const firstLine = redactedMessage.split("\n")[0].trim();
  let userMessage = firstLine || "Gateway error.";
  if (hasExit) userMessage += ` (exit ${input.exitCode})`;

  const detailParts = [redactedMessage.trim()].filter(Boolean);
  if (redactedStderr) detailParts.push(redactedStderr);
  const operatorDetail = detailParts.join("\n") || userMessage;

  const localLogPath = writeLocalLog(input, logDir);

  return { userMessage, operatorDetail, localLogPath };
}
