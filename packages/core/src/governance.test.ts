import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_GOVERNANCE_POLICY,
  Governance,
  InMemoryUsageStore,
  MemoryAuditSink,
  estimateRequestTokens,
  estimateTokens,
} from "./governance.js";

const NOW = Date.parse("2026-10-30T10:00:00+08:00");
const scope = { ownerId: "user-a", companionId: "companion" };

function governance(policy: Partial<typeof DEFAULT_GOVERNANCE_POLICY> = {}) {
  const sink = new MemoryAuditSink();
  return {
    sink,
    instance: new Governance({ policy, sink, now: () => NOW }),
  };
}

describe("Governance", () => {
  it("allows turns by default", () => {
    const { instance } = governance();
    assert.deepEqual(instance.canStart(scope, { inputTokens: 100_000 }), { allowed: true });
  });

  it("blocks every turn while paused and records why", () => {
    const { instance, sink } = governance();
    instance.pause("maintenance");
    const decision = instance.canStart(scope, { inputTokens: 10 });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "paused");
    assert.ok(sink.list().some((entry) => entry.type === "governance.paused"));
    instance.resume();
    assert.deepEqual(instance.canStart(scope, { inputTokens: 10 }), { allowed: true });
  });

  it("enforces per-turn input and output budgets", () => {
    const { instance } = governance({
      maxInputTokensPerTurn: 100,
      maxOutputTokensPerTurn: 50,
      expectedOutputTokens: 64,
    });
    const input = instance.canStart(scope, { inputTokens: 101 });
    assert.equal(input.allowed, false);
    if (!input.allowed) assert.equal(input.reason, "turn_input_budget");

    const output = instance.canStart(scope, { inputTokens: 10 });
    assert.equal(output.allowed, false);
    if (!output.allowed) assert.equal(output.reason, "turn_output_budget");
  });

  it("accumulates the daily token budget per owner", () => {
    const { instance } = governance({ maxTokensPerDay: 1000, expectedOutputTokens: 100 });
    instance.recordTurn(scope, { inputTokens: 400, outputTokens: 500, latencyMs: 1, provider: "test" });
    assert.deepEqual(instance.usageFor("user-a").tokens, 900);

    const decision = instance.canStart(scope, { inputTokens: 50 });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "day_token_budget");

    // Another owner has their own budget.
    assert.deepEqual(instance.canStart({ ownerId: "user-b" }, { inputTokens: 50 }), { allowed: true });
  });

  it("estimates cost and enforces the daily cost cap", () => {
    const { instance } = governance({
      maxCostPerDay: 2,
      pricePerMillionInputTokens: 1,
      pricePerMillionOutputTokens: 2,
      expectedOutputTokens: 0,
    });
    const cost = instance.recordTurn(scope, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      latencyMs: 1,
      provider: "test",
    });
    assert.equal(cost, 3);
    const decision = instance.canStart(scope, { inputTokens: 0 });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "day_cost_budget");
  });

  it("records completed and blocked turns in the audit log", () => {
    const { instance, sink } = governance();
    instance.recordTurn(scope, { inputTokens: 10, outputTokens: 20, latencyMs: 5, provider: "test" });
    instance.recordBlocked(scope, "paused", "test");
    const types = sink.list().map((entry) => entry.type);
    assert.deepEqual(types, ["turn.completed", "turn.blocked"]);
  });

  it("estimates CJK text more heavily than latin text", () => {
    assert.equal(estimateTokens("你好世界"), 4);
    assert.equal(estimateTokens("hello world"), 3);
    assert.ok(
      estimateRequestTokens({
        systemPrompt: "系统提示",
        history: ["你好"],
        userText: "在吗",
      }) > 0,
    );
  });

  it("persists daily usage through the usage store", () => {
    const usageStore = new InMemoryUsageStore();
    const first = new Governance({ usageStore, now: () => NOW });
    first.recordTurn(scope, {
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1,
      provider: "test",
    });

    // A new instance (a restart) sees the same counters.
    const second = new Governance({ usageStore, now: () => NOW });
    assert.equal(second.usageFor("user-a").tokens, 150);
  });
});
