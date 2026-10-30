import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskRunner } from "./task.js";

describe("TaskRunner", () => {
  it("retries until the verifier passes", async () => {
    const runner = new TaskRunner({
      executor: {
        execute: ({ attempts }) => ({ content: `attempt ${attempts.length + 1}` }),
      },
      verifier: {
        name: "test",
        check: (artifact) => ({ ok: artifact.content === "attempt 2", detail: artifact.content }),
      },
    });
    const run = await runner.run({ id: "t1", goal: "g", maxAttempts: 3 });
    assert.equal(run.status, "verified");
    assert.equal(run.attempts.length, 2);
    assert.equal(run.winner?.content, "attempt 2");
  });

  it("exhausts after maxAttempts", async () => {
    const runner = new TaskRunner({
      executor: { execute: () => ({ content: "x" }) },
      verifier: { name: "test", check: () => ({ ok: false, detail: "nope" }) },
    });
    const run = await runner.run({ id: "t2", goal: "g", maxAttempts: 3 });
    assert.equal(run.status, "exhausted");
    assert.equal(run.attempts.length, 3);
  });

  it("keeps going when the executor throws", async () => {
    const runner = new TaskRunner({
      executor: {
        execute: () => {
          throw new Error("boom");
        },
      },
      verifier: { name: "test", check: () => ({ ok: false, detail: "no" }) },
      logger: { warn: () => undefined },
    });
    const run = await runner.run({ id: "t3", goal: "g", maxAttempts: 2 });
    assert.equal(run.status, "exhausted");
    assert.equal(run.verifications.length, 2);
    assert.match(run.verifications[0]?.detail ?? "", /boom/u);
  });

  it("stops when canStart says no", async () => {
    const runner = new TaskRunner({
      executor: { execute: () => ({ content: "x" }) },
      verifier: { name: "test", check: () => ({ ok: true, detail: "ok" }) },
      canStart: () => false,
    });
    const run = await runner.run({ id: "t4", goal: "g" });
    assert.equal(run.status, "blocked");
    assert.equal(run.attempts.length, 0);
  });

  it("calls onAttempt for every try", async () => {
    const seen: string[] = [];
    const runner = new TaskRunner({
      executor: { execute: ({ attempts }) => ({ content: String(attempts.length) }) },
      verifier: { name: "test", check: (artifact) => ({ ok: artifact.content === "1", detail: "ok" }) },
      onAttempt: (artifact, result) => seen.push(`${artifact.attempt}:${result.ok}`),
    });
    const run = await runner.run({ id: "t5", goal: "g", maxAttempts: 3 });
    assert.equal(run.status, "verified");
    assert.deepEqual(seen, ["1:false", "2:true"]);
  });

  it("returns blocked when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new TaskRunner({
      executor: { execute: () => ({ content: "x" }) },
      verifier: { name: "test", check: () => ({ ok: true, detail: "ok" }) },
    });
    const run = await runner.run({ id: "t6", goal: "g" }, { signal: controller.signal });
    assert.equal(run.status, "blocked");
  });
});
