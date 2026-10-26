import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openSqliteStorage } from "./index.js";

const directory = mkdtempSync(join(tmpdir(), "isla-store-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const scope = { ownerId: "u1", companionId: "isla", conversationId: "c1" };

describe("sqlite storage", () => {
  it("persists memories, history, emotion and proactive jobs across restarts", () => {
    const path = join(directory, "isla.sqlite");
    const first = openSqliteStorage({ path });
    first.memory.add(
      {
        type: "preference",
        content: "用户喜欢下雨天",
        importance: 0.8,
        confidence: 0.9,
        key: "preference.weather",
      },
      { ownerId: "u1", companionId: "isla", now: 1000 },
    );
    first.history.append(scope, {
      id: "m1",
      role: "user",
      text: "我喜欢下雨天",
      createdAt: 1000,
    });
    first.history.saveSummary(scope, { summary: "用户喜欢下雨天。", coveredUntil: 1000, updatedAt: 1000 });
    first.emotion.set({ ownerId: "u1", companionId: "isla" }, {
      pleasure: 0.4,
      arousal: 0.1,
      dominance: 0,
      trust: 0.2,
      bonding: 0.3,
      energy: 0.6,
      updatedAt: 1000,
    });
    first.proactive.save({
      id: "j1",
      ownerId: "u1",
      companionId: "isla",
      conversationId: "c1",
      channel: "platform",
      text: "晚安",
      dueAt: 2000,
      status: "pending",
      createdAt: 1000,
    });
    first.close();

    const second = openSqliteStorage({ path });
    const memories = second.memory.list({ ownerId: "u1", companionId: "isla" });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.content, "用户喜欢下雨天");
    assert.equal(memories[0]?.key, "preference.weather");

    assert.equal(second.history.recentMessages(scope, 10).length, 1);
    assert.equal(second.history.getSummary(scope)?.summary, "用户喜欢下雨天。");
    assert.equal(second.history.lastUserMessageAt(scope), 1000);
    assert.equal(second.emotion.get({ ownerId: "u1", companionId: "isla" })?.bonding, 0.3);
    assert.equal(second.proactive.list("u1")[0]?.text, "晚安");
    second.close();
  });

  it("deletes a memory and a conversation", () => {
    const storage = openSqliteStorage({ path: join(directory, "delete.sqlite") });
    const record = storage.memory.add(
      { type: "fact", content: "用户住在杭州" },
      { ownerId: "u1", companionId: "isla", now: 1000 },
    );
    storage.history.append(scope, { id: "m2", role: "user", text: "我在杭州", createdAt: 1000 });
    assert.equal(storage.memory.remove(record.id), true);
    assert.equal(storage.memory.list({ ownerId: "u1", companionId: "isla" }).length, 0);
    storage.history.deleteConversation(scope);
    assert.equal(storage.history.recentMessages(scope, 10).length, 0);
    storage.close();
  });
});
