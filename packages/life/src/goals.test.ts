import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVITIES } from "./activities.js";
import { DAY } from "./clock.js";
import { MemoryArchive } from "./events.js";
import { ISLA_GENOME } from "./genome.js";
import { Life } from "./life.js";
import { replay } from "./state.js";
import { createRoom } from "./world.js";

const readOnly = ACTIVITIES.filter((kind) => kind.id === "read");
const longBook = {
  id: "long",
  title: "长书",
  passages: Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 段`),
};

async function born(now: { value: number }): Promise<Life> {
  return Life.open({
    genome: ISLA_GENOME,
    world: createRoom({ seed: "goals", books: [longBook] }),
    archive: new MemoryArchive(),
    clock: () => now.value,
    activities: readOnly,
  });
}

describe("goals", () => {
  it("aims at a book she has started, then finishes it and keeps the goal in the log", async () => {
    const now = { value: Date.parse("2026-11-01T05:30:00+08:00") };
    const life = await born(now);
    for (let day = 0; day < 8; day++) {
      now.value += DAY;
      await life.advanceTo(now.value);
    }
    const events = life.events();
    const aimed = events.filter((event) => event.kind === "aimed");
    const progressed = events.filter((event) => event.kind === "progressed");
    const achieved = events.filter((event) => event.kind === "achieved");

    assert.ok(aimed.length > 0, "she set herself something");
    for (const event of aimed) {
      if (event.kind !== "aimed") continue;
      assert.ok(event.payload.grounds.length > 0, "a goal rests on something that happened");
      assert.match(event.payload.statement, /读完/u);
    }
    assert.ok(progressed.length > 0, "reading moved it forward");
    assert.ok(achieved.length > 0, "she finished the book");

    const rebuilt = replay(events);
    assert.ok(rebuilt);
    assert.deepEqual(rebuilt.goals, life.state.goals);
    const active = Object.values(life.state.goals).filter((goal) => goal.status === "active");
    assert.equal(active.length, 0);
  });
});
