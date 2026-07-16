/**
 * OpenAI-compatible HTTP client for gateway profiles.
 * Uses globalThis.fetch (Node 18.18+). No external dependencies.
 */

import { redactText } from "./redaction.mjs";

const DEFAULT_IDLE_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUrl(baseUrl, urlPath) {
  const base = baseUrl.replace(/\/+$/, "");
  const prefix = base.endsWith("/v1") ? base : `${base}/v1`;
  return `${prefix}${urlPath}`;
}

function buildHeaders(profile) {
  const token = profile.authToken || profile.apiKey || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

async function readCappedRaw(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let result = "";
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error(`Response body exceeded ${maxBytes} byte limit`);
    }
    total += value.byteLength;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

// Falls back to res.text()/res.json() when there's no readable stream body to
// cap (e.g. minimal fetch mocks in tests) — real fetch() responses always
// have a streamable body, so the cap applies in production.
async function readCappedText(res, maxBytes = MAX_RESPONSE_BYTES) {
  const raw = await readCappedRaw(res, maxBytes);
  return raw !== null ? raw : res.text();
}

async function readCappedJson(res, maxBytes = MAX_RESPONSE_BYTES) {
  const raw = await readCappedRaw(res, maxBytes);
  return raw !== null ? JSON.parse(raw) : res.json();
}

/**
 * Collect a single profile's literal secret values (apiKey/authToken) for
 * scrubbing. A 401/403 body can echo the raw key with no `Bearer` prefix, so
 * the generic Bearer/URL rules alone can't mask it — the caller must pass the
 * profile's own secrets to sanitizeError.
 * @param {{apiKey?: string, authToken?: string}} [profile]
 * @returns {string[]}
 */
export function profileSecrets(profile) {
  return [profile?.apiKey, profile?.authToken].filter((s) => typeof s === "string" && s.length > 0);
}

export function sanitizeError(error, secrets = []) {
  // Strip anything that could leak auth tokens/credentials from error messages.
  // Delegates to the shared redactor. Callers with access to profile secrets
  // pass them so a literal key echoed in a response body (no `Bearer` prefix)
  // is masked too; with no secrets, the Bearer/URL/query rules still apply.
  const msg = error instanceof Error ? error.message : String(error);
  return redactText(msg, secrets);
}

export function extractJson(content) {
  if (typeof content !== "string") return { value: content, ok: true };
  try { return { value: JSON.parse(content), ok: true }; } catch {}
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/gi;
  let last = null;
  let m;
  while ((m = fenceRe.exec(content)) !== null) last = m[1];
  if (last !== null) {
    try { return { value: JSON.parse(last), ok: true }; } catch {}
  }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return { value: JSON.parse(content.slice(start, end + 1)), ok: true }; } catch {}
  }
  return { value: null, ok: false };
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
export const REQUEST_TIMEOUT_MS = 60_000;
const RETRIABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRIABLE_NET_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED",
  "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
    let onAbort;
    const timer = setTimeout(() => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function parseRetryAfter(headers) {
  const val = headers?.get?.("retry-after") ?? headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!val) return null;
  const secs = Number(val);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 300_000);
  const dateMs = Date.parse(val);
  if (!Number.isNaN(dateMs)) return Math.min(Math.max(dateMs - Date.now(), 0), 300_000);
  return null;
}

async function withRetry(fn, externalSignal, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let onAbort;
    if (externalSignal) {
      onAbort = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener("abort", onAbort, { once: true });
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
    }
    try {
      return await fn(controller.signal);
    } catch (err) {
      lastError = err;
      if (err.name === "AbortError") throw err;
      if (externalSignal?.aborted) throw err;
      if (attempt === MAX_RETRIES - 1) throw err;
      const status = err.status ?? parseInt(err.message?.match(/\((\d+)\)/)?.[1] ?? "0", 10);
      const isNetworkError = err.name === "TypeError" && RETRIABLE_NET_CODES.has(err.cause?.code);
      const isRetriable = isNetworkError || RETRIABLE_STATUS.has(status);
      if (!isRetriable) throw err;
      const retryAfter = err.retryAfter ?? (status === 429 ? parseRetryAfter(err.headers) : null);
      const delay = retryAfter ?? BASE_DELAY_MS * 2 ** attempt * (0.8 + Math.random() * 0.4);
      await sleep(delay, externalSignal);
    } finally {
      clearTimeout(timer);
      if (onAbort && externalSignal) externalSignal.removeEventListener("abort", onAbort);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// chatCompletion — non-streaming
// ---------------------------------------------------------------------------

export async function chatCompletion(profile, messages, opts = {}) {
  const url = buildUrl(profile.baseUrl, "/chat/completions");
  const body = {
    model: opts.model || profile.defaultModel,
    messages,
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.max_tokens !== undefined && { max_tokens: opts.max_tokens }),
    ...(opts.top_p !== undefined && { top_p: opts.top_p }),
    ...(opts.stop !== undefined && { stop: opts.stop }),
    ...(opts.response_format !== undefined && { response_format: opts.response_format }),
    ...(opts.tools !== undefined && { tools: opts.tools }),
    ...(opts.tool_choice !== undefined && { tool_choice: opts.tool_choice }),
    stream: false,
  };

  return withRetry(async (signal) => {
    const res = await globalThis.fetch(url, {
      method: "POST",
      headers: buildHeaders(profile),
      body: JSON.stringify(body),
      signal,
      redirect: "manual",
    });

    if (!res.ok) {
      const text = await readCappedText(res).catch(() => "");
      const err = new Error(`Chat completion failed (${res.status}): ${text}`);
      err.status = res.status;
      err.headers = res.headers;
      throw err;
    }

    return readCappedJson(res);
  }, opts.signal, { timeoutMs: opts.timeoutMs });
}

// ---------------------------------------------------------------------------
// chatCompletionStream — SSE async generator
// ---------------------------------------------------------------------------

export async function* chatCompletionStream(profile, messages, opts = {}) {
  const url = buildUrl(profile.baseUrl, "/chat/completions");
  const body = {
    model: opts.model || profile.defaultModel,
    messages,
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.max_tokens !== undefined && { max_tokens: opts.max_tokens }),
    ...(opts.top_p !== undefined && { top_p: opts.top_p }),
    ...(opts.stop !== undefined && { stop: opts.stop }),
    ...(opts.response_format !== undefined && { response_format: opts.response_format }),
    ...(opts.tools !== undefined && { tools: opts.tools }),
    ...(opts.tool_choice !== undefined && { tool_choice: opts.tool_choice }),
    stream: true,
    ...(opts.stream_options !== undefined && { stream_options: opts.stream_options }),
  };

  const idleTimeout = opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
  const controller = new AbortController();
  const externalSignal = opts.signal;

  let onAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      onAbort = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const res = await globalThis.fetch(url, {
    method: "POST",
    headers: buildHeaders(profile),
    body: JSON.stringify(body),
    signal: controller.signal,
    redirect: "manual",
  });

  if (!res.ok) {
    const text = await readCappedText(res).catch(() => "");
    throw new Error(`Stream request failed (${res.status}): ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleTimer = null;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTimeout > 0) {
      idleTimer = setTimeout(() => {
        controller.abort(new Error(`Idle timeout after ${idleTimeout}ms`));
      }, idleTimeout);
    }
  };

  try {
    resetIdle();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      resetIdle();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed === "data: [DONE]") {
          return;
        }

        if (trimmed.startsWith("data: ")) {
          const json = trimmed.slice(6);
          try {
            const parsed = JSON.parse(json);
            const choice = parsed.choices?.[0];
            yield {
              content: choice?.delta?.content ?? null,
              finishReason: choice?.finish_reason ?? null,
              usage: parsed.usage ?? null,
            };
          } catch {
            // Malformed JSON chunk — skip
          }
        }
      }
    }

    buffer += decoder.decode(); // flush remaining bytes

    // Process any remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          const choice = parsed.choices?.[0];
          yield {
            content: choice?.delta?.content ?? null,
            finishReason: choice?.finish_reason ?? null,
            usage: parsed.usage ?? null,
          };
        } catch {
          // ignore
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    reader.releaseLock();
    if (onAbort && externalSignal) {
      externalSignal.removeEventListener("abort", onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// runDirectReview — convenience wrapper
// ---------------------------------------------------------------------------

export async function runDirectReview(profile, systemPrompt, userPrompt, opts = {}) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const result = await chatCompletion(profile, messages, opts);
  const choice = result.choices?.[0];
  const content = choice?.message?.content ?? "";
  const model = result.model ?? profile.defaultModel;
  const usage = result.usage ?? null;

  const { value, ok } = extractJson(content);
  return { content: ok ? value : content, model, usage, parsed: ok };
}

// ---------------------------------------------------------------------------
// testConnectivity — quick health probe
// ---------------------------------------------------------------------------

export async function testConnectivity(profile, opts = {}) {
  const start = Date.now();
  try {
    const result = await chatCompletion(profile, [{ role: "user", content: "hi" }], {
      max_tokens: 1,
      timeoutMs: opts.timeoutMs,
    });
    return {
      ok: true,
      latencyMs: Date.now() - start,
      model: result.model ?? profile.defaultModel,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      model: null,
      error: sanitizeError(err, profileSecrets(profile)),
    };
  }
}

// ---------------------------------------------------------------------------
// listModels — GET /v1/models
// ---------------------------------------------------------------------------

export async function listModels(profile) {
  const url = buildUrl(profile.baseUrl, "/models");
  const res = await globalThis.fetch(url, {
    method: "GET",
    headers: buildHeaders(profile),
    redirect: "manual",
  });

  if (!res.ok) {
    const text = await readCappedText(res).catch(() => "");
    throw new Error(`List models failed (${res.status}): ${text}`);
  }

  const body = await readCappedJson(res);
  return (body.data || []).map((m) => m.id);
}
