import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProactiveScheduler } from "./scheduler.js";

const permissive = {
  enabled: true,
  maxPerDay: 99,
  minGapMs: 0,
  timezone: "UTC",
} as const;

function addNight(scheduler: ProactiveScheduler, dueAt = 2000): void {
  scheduler.add({
    ownerId: "user-a",
    companionId: "companion",
    conversationId: "web:user-a",
    channel: "platform",
    text: "晚安",
    dueAt,
    dedupeKey: "good-night:2026-10-01",
  });
}

describe("ProactiveScheduler", () => {
  it("deduplicates pending proactive jobs", () => {
    const scheduler = new ProactiveScheduler({ policy: permissive });
    addNight(scheduler);
    const first = scheduler.list()[0];
    assert.ok(first);
    const duplicate = scheduler.add({
      ownerId: "user-a",
      companionId: "companion",
      conversationId: "web:user-a",
      channel: "platform",
      text: "晚安",
      dueAt: 2000,
      dedupeKey: "good-night:2026-10-01",
    });

    assert.equal(duplicate.id, first.id);
    assert.equal(scheduler.due(2000).length, 1);
  });

  it("sends nothing while the master switch is off (the default)", () => {
    const scheduler = new ProactiveScheduler();
    addNight(scheduler);
    assert.equal(scheduler.due(2000).length, 0);
    assert.equal(scheduler.currentPolicy.enabled, false);
  });

  it("respects quiet hours, including windows that cross midnight", () => {
    const scheduler = new ProactiveScheduler({
      policy: { ...permissive, quietHours: { start: "23:00", end: "08:00" } },
    });
    addNight(scheduler, Date.UTC(2026, 9, 1, 23, 30));
    const lateNight = Date.UTC(2026, 9, 1, 23, 30);
    assert.equal(scheduler.due(lateNight).length, 0);

    const morning = Date.UTC(2026, 9, 2, 9, 0);
    assert.equal(scheduler.due(morning).length, 1);
  });

  it("caps deliveries per day and enforces the cooldown", () => {
    const scheduler = new ProactiveScheduler({
      policy: { ...permissive, maxPerDay: 1, minGapMs: 4 * 60 * 60 * 1000 },
    });
    addNight(scheduler, Date.UTC(2026, 9, 1, 9, 0));
    const job = scheduler.due(Date.UTC(2026, 9, 1, 9, 0))[0];
    assert.ok(job);
    scheduler.markSent(job.id, Date.UTC(2026, 9, 1, 9, 0));

    // Same day, one hour later: daily cap.
    assert.equal(scheduler.due(Date.UTC(2026, 9, 1, 10, 0)).length, 0);

    // Next day, one hour after the previous send: cooldown.
    assert.equal(scheduler.due(Date.UTC(2026, 9, 2, 10, 0)).length, 0);

    // Next day, five hours later: allowed again.
    addNight(scheduler, Date.UTC(2026, 9, 2, 14, 0));
    assert.equal(scheduler.due(Date.UTC(2026, 9, 2, 14, 0)).length, 1);
  });
});
