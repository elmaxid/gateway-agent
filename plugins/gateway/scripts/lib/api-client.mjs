/**
 * OpenAI-compatible HTTP client for gateway profiles.
 * Uses globalThis.fetch (Node 18.18+). No external dependencies.
 */

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

function sanitizeError(error) {
  // Strip anything that could leak auth tokens from error messages
  const msg = error instanceof Error ? error.message : String(error);
  return msg.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
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

  const res = await globalThis.fetch(url, {
    method: "POST",
    headers: buildHeaders(profile),
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat completion failed (${res.status}): ${text}`);
  }

  return res.json();
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
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
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

  let parsed = false;
  let parsedContent = content;
  try {
    parsedContent = JSON.parse(content);
    parsed = true;
  } catch {
    // content is not JSON — return as string
  }

  return { content: parsed ? parsedContent : content, model, usage, parsed };
}

// ---------------------------------------------------------------------------
// testConnectivity — quick health probe
// ---------------------------------------------------------------------------

export async function testConnectivity(profile) {
  const start = Date.now();
  try {
    const result = await chatCompletion(profile, [{ role: "user", content: "hi" }], {
      max_tokens: 1,
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
      error: sanitizeError(err),
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
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`List models failed (${res.status}): ${text}`);
  }

  const body = await res.json();
  return (body.data || []).map((m) => m.id);
}
