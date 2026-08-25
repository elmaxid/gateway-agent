/**
 * Task 21 side-finding: terminateProcessTreeAsync's grace period wasn't
 * actually honored. It delegated to the SYNCHRONOUS terminateProcessTree
 * with an async `sleepImpl` swapped in -- but terminateProcessTree calls
 * `sleepImpl(sleepMs)` as a plain (unawaited) statement, since it isn't
 * itself async. A Promise-returning sleepImpl just fires a timer and gets
 * discarded; execution falls straight through to the liveness check almost
 * instantly instead of waiting out the grace period. Net effect: SIGKILL
 * landed right after SIGTERM in practice, never giving the process the
 * intended window to exit on its own.
 *
 * Discovered while testing session-lifecycle-hook.mjs's Task 21 fix -- a
 * test relying on the real ~2s grace period to create a race window never
 * reproduced it reliably, because the window was actually only a few ms.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { terminateProcessTree, terminateProcessTreeAsync } from "../plugins/gateway/scripts/lib/process.mjs";

function makeFakeKill({ diesAfterTermMs = null } = {}) {
  const calls = [];
  let termedAt = null;
  const killImpl = (pid, signal) => {
    calls.push({ pid, signal, t: Date.now() });
    if (signal === "SIGTERM") {
      termedAt = Date.now();
      return;
    }
    if (signal === 0) {
      // Liveness probe: throw (process gone) once diesAfterTermMs has elapsed
      // since SIGTERM; otherwise report still alive (no throw).
      if (diesAfterTermMs !== null && termedAt !== null && Date.now() - termedAt >= diesAfterTermMs) {
        const err = new Error("ESRCH"); err.code = "ESRCH"; throw err;
      }
      return; // still alive
    }
    // SIGKILL or anything else: no-op
  };
  return { killImpl, calls };
}

describe("terminateProcessTreeAsync actually awaits the grace period", () => {
  it("takes at least gracePeriodMs of real wall time before escalating to SIGKILL", async () => {
    const { killImpl, calls } = makeFakeKill(); // never "dies" on its own -- forces the full wait + escalation
    const gracePeriodMs = 200;

    const t0 = Date.now();
    const result = await terminateProcessTreeAsync(12345, { killImpl, gracePeriodMs, platform: "linux" });
    const elapsed = Date.now() - t0;

    assert.ok(elapsed >= gracePeriodMs, `Expected at least ${gracePeriodMs}ms elapsed (real await), got ${elapsed}ms`);
    assert.equal(result.delivered, true);
    assert.equal(result.method, "process-group+sigkill");

    const signals = calls.map((c) => c.signal);
    assert.deepEqual(signals, ["SIGTERM", 0, "SIGKILL"], "SIGTERM, then liveness probe AFTER the wait, then SIGKILL");
  });

  it("does not escalate to SIGKILL if the process exits during the grace period", async () => {
    const { killImpl } = makeFakeKill({ diesAfterTermMs: 50 });
    const result = await terminateProcessTreeAsync(12345, { killImpl, gracePeriodMs: 200, platform: "linux" });

    assert.equal(result.delivered, true);
    assert.equal(result.method, "process-group", "no +sigkill suffix -- it was already gone by the liveness check");
  });

  it("terminateProcessTree (sync) is unaffected by the async fix -- same contract, still blocks synchronously", () => {
    const { killImpl, calls } = makeFakeKill();
    const gracePeriodMs = 50;

    const t0 = Date.now();
    const result = terminateProcessTree(12345, { killImpl, gracePeriodMs, platform: "linux" });
    const elapsed = Date.now() - t0;

    assert.ok(elapsed >= gracePeriodMs, `Expected sync call to block at least ${gracePeriodMs}ms, got ${elapsed}ms`);
    assert.equal(result.method, "process-group+sigkill");
    assert.deepEqual(calls.map((c) => c.signal), ["SIGTERM", 0, "SIGKILL"]);
  });
});
