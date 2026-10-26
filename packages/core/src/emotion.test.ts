import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_EMOTION_STATE, emotionLabel, updateEmotion } from "./emotion.js";

describe("emotion state", () => {
  it("applies important events and maps them to a visible label", () => {
    const current = { ...DEFAULT_EMOTION_STATE, updatedAt: 1000 };
    const next = updateEmotion(
      current,
      {
        delta: { pleasure: 0.8, arousal: 0.7 },
        importance: 1,
        reason: "shared good news",
      },
      { now: 2000 },
    );

    assert.ok(next.pleasure > current.pleasure);
    assert.ok(next.arousal > current.arousal);
    assert.equal(emotionLabel(next), "兴奋");
  });

  it("decays toward the base state over time", () => {
    const current = { ...DEFAULT_EMOTION_STATE, pleasure: 1, updatedAt: 1000 };
    const next = updateEmotion(
      current,
      { delta: {}, importance: 0, reason: "time passed" },
      { now: 100000, decayRatePerSecond: 0.01 },
    );

    assert.ok(next.pleasure < current.pleasure);
  });
});
