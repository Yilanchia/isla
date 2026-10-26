import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore, cosineSimilarity, hashedEmbedding } from "./memory.js";

describe("MemoryStore", () => {
  it("ranks relevant memories and keeps owner scopes isolated", () => {
    const store = new MemoryStore();
    store.add(
      {
        type: "preference",
        content: "用户喜欢晚上听音乐",
        importance: 0.8,
        confidence: 0.95,
      },
      { ownerId: "user-a", companionId: "companion", now: 1000 },
    );
    store.add(
      {
        type: "fact",
        content: "用户喜欢早上跑步",
        importance: 0.4,
        confidence: 0.8,
      },
      { ownerId: "user-b", companionId: "companion", now: 1000 },
    );

    const results = store.search("晚上音乐", {
      ownerId: "user-a",
      companionId: "companion",
      now: 2000,
    });

    assert.equal(results.length, 1);
    assert.match(results[0]?.content ?? "", /晚上听音乐/u);
    assert.ok((results[0]?.score ?? 0) > 0);
    assert.equal(results[0]?.embedding, undefined, "fallback vectors stay transient until a real provider is configured");
  });

  it("produces normalized fallback embeddings", () => {
    const vector = hashedEmbedding("persistent memory");
    assert.ok(Math.abs(cosineSimilarity(vector, vector) - 1) < 0.000001);
  });

  it("merges identical memories within the same owner scope", () => {
    const store = new MemoryStore();
    const first = store.add(
      {
        type: "preference",
        content: "喜欢简洁回答",
        importance: 0.6,
        confidence: 0.7,
        sourceMessageIds: ["message-1"],
      },
      { ownerId: "user-a", companionId: "companion", now: 1000 },
    );
    const second = store.add(
      {
        type: "preference",
        content: "  喜欢简洁回答 ",
        importance: 0.9,
        confidence: 0.95,
        sourceMessageIds: ["message-2"],
      },
      { ownerId: "user-a", companionId: "companion", now: 2000 },
    );

    assert.equal(second.id, first.id);
    assert.equal(store.list({ ownerId: "user-a", companionId: "companion" }).length, 1);
    assert.equal(second.importance, 0.9);
    assert.deepEqual(second.sourceMessageIds, ["message-1", "message-2"]);
  });

  it("retrieves only memories active at the search time and records access", () => {
    const store = new MemoryStore([
      {
        id: "active",
        ownerId: "user-a",
        companionId: "companion",
        type: "fact",
        content: "用户喜欢听音乐",
        importance: 0.8,
        confidence: 0.9,
        createdAt: 100,
        lastAccessedAt: 500,
        validFrom: 100,
        sourceMessageIds: [],
      },
      {
        id: "future",
        ownerId: "user-a",
        companionId: "companion",
        type: "fact",
        content: "用户将来喜欢听音乐",
        importance: 0.8,
        confidence: 0.9,
        createdAt: 100,
        lastAccessedAt: 500,
        validFrom: 3000,
        sourceMessageIds: [],
      },
      {
        id: "expired",
        ownerId: "user-a",
        companionId: "companion",
        type: "fact",
        content: "用户曾经喜欢听音乐",
        importance: 0.8,
        confidence: 0.9,
        createdAt: 100,
        lastAccessedAt: 500,
        validFrom: 100,
        validTo: 1500,
        sourceMessageIds: [],
      },
    ]);

    const results = store.search("喜欢听音乐", {
      ownerId: "user-a",
      companionId: "companion",
      now: 2000,
    });

    assert.deepEqual(results.map((memory) => memory.id), ["active"]);
    assert.equal(results[0]?.lastAccessedAt, 2000);
    assert.equal(store.get("active")?.lastAccessedAt, 2000);
  });

  it("versions keyed facts instead of overwriting their evidence", () => {
    const store = new MemoryStore();
    const oldMemory = store.add(
      {
        type: "preference",
        key: "preference.food",
        content: "用户喜欢吃辣",
        origin: "user_explicit",
        sourceMessageIds: ["message-old"],
      },
      { ownerId: "user-a", companionId: "companion", now: 100 },
    );
    const newMemory = store.add(
      {
        type: "preference",
        key: "preference.food",
        content: "用户现在不喜欢吃辣了",
        origin: "user_explicit",
        sourceMessageIds: ["message-new"],
      },
      { ownerId: "user-a", companionId: "companion", now: 200 },
    );

    assert.equal(store.get(oldMemory.id)?.validTo, 200);
    assert.equal(store.get(newMemory.id)?.validFrom, 200);
    assert.deepEqual(
      store.search("吃辣", { ownerId: "user-a", companionId: "companion", now: 150 }).map((memory) => memory.id),
      [oldMemory.id],
    );
    assert.deepEqual(
      store.search("吃辣", { ownerId: "user-a", companionId: "companion", now: 200 }).map((memory) => memory.id),
      [newMemory.id],
    );
    assert.deepEqual(store.takeUpdatedRecords().map((memory) => [memory.id, memory.validTo]), [[oldMemory.id, 200]]);
  });

  it("uses MMR to avoid returning near-duplicate memories", () => {
    const store = new MemoryStore([
      {
        id: "a",
        ownerId: "user-a",
        companionId: "companion",
        type: "fact",
        content: "用户养了一只猫",
        importance: 0.8,
        confidence: 0.9,
        createdAt: 1,
        lastAccessedAt: 1,
        validFrom: 1,
        sourceMessageIds: [],
        embedding: [1, 0],
      },
      {
        id: "b",
        ownerId: "user-a",
        companionId: "companion",
        type: "fact",
        content: "用户养了一只小猫",
        importance: 0.8,
        confidence: 0.9,
        createdAt: 1,
        lastAccessedAt: 1,
        validFrom: 1,
        sourceMessageIds: [],
        embedding: [1, 0],
      },
      {
        id: "c",
        ownerId: "user-a",
        companionId: "companion",
        type: "preference",
        content: "用户喜欢晚上散步",
        importance: 0.8,
        confidence: 0.9,
        createdAt: 1,
        lastAccessedAt: 1,
        validFrom: 1,
        sourceMessageIds: [],
        embedding: [0, 1],
      },
    ]);

    const results = store.search("用户的宠物", {
      ownerId: "user-a",
      companionId: "companion",
      limit: 2,
      now: 2,
      embedding: [1, 0],
    });

    assert.equal(results.length, 2);
    assert.notEqual(results[0]?.embedding?.join(","), results[1]?.embedding?.join(","));
  });
});
