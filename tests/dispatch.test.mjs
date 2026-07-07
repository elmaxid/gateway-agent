import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Semaphore, normalizeBaseUrl } from "../plugins/gateway/scripts/lib/concurrency.mjs";

describe("Semaphore", () => {
  it("allows up to max concurrent executions", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const task = () => sem.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 50));
      active--;
    });
    await Promise.all([task(), task(), task(), task()]);
    assert.equal(maxActive, 2);
  });

  it("run() returns the function result", async () => {
    const sem = new Semaphore(1);
    const result = await sem.run(async () => 42);
    assert.equal(result, 42);
  });

  it("run() releases on throw", async () => {
    const sem = new Semaphore(1);
    await assert.rejects(() => sem.run(() => { throw new Error("boom"); }), /boom/);
    const result = await sem.run(async () => "ok");
    assert.equal(result, "ok");
  });
});

describe("normalizeBaseUrl", () => {
  it("strips path and trailing slash", () => {
    assert.equal(normalizeBaseUrl("http://host:4000/v1/"), "http://host:4000");
  });

  it("returns input for invalid URLs", () => {
    assert.equal(normalizeBaseUrl("not-a-url"), "not-a-url");
  });
});
