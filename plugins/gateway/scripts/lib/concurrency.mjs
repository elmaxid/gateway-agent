export class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
  async run(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}

// Sentinel prefix for un-parseable baseUrls. The interior space is
// load-bearing and MUST NOT be removed: a successfully-parsed URL's
// `${protocol}//${host}` can never contain a whitespace character (URL
// schemes match [a-zA-Z][a-zA-Z0-9+.-]* and hosts forbid space/tab/newline),
// so any key containing a space is provably disjoint from every success-branch
// key. NOTE: the *word* "invalid-base-url" alone is a valid scheme
// (`new URL("invalid-base-url://x")` parses), so the word cannot be the
// distinguisher — the SPACE is.
const INVALID_BASEURL_PREFIX = "invalid-base-url ";

export function normalizeBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    // Embed the raw input (not a constant) so two distinct un-parseable
    // endpoints get distinct semaphore keys instead of wrongly sharing a
    // concurrency budget. The prefix's space guarantees this key can never
    // equal any success-branch key.
    return `${INVALID_BASEURL_PREFIX}${baseUrl}`;
  }
}
