import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVITIES } from "./activities.js";
import { DAY, HOUR } from "./clock.js";
import { MemoryArchive } from "./events.js";
import { createGenome, ISLA_GENOME } from "./genome.js";
import { Life } from "./life.js";
import { createRoom } from "./world.js";

describe("habituation", () => {
  it("gets used to the same passage", async () => {
    const now = { value: Date.parse("2026-11-01T05:30:00+08:00") };
    const life = await Life.open({
      genome: ISLA_GENOME,
      world: createRoom({ seed: "hab", books: [{ id: "one", title: "一段书", passages: ["同一段"] }] }),
      archive: new MemoryArchive(),
      clock: () => now.value,
      activities: ACTIVITIES.filter((kind) => kind.id === "read"),
    });
    for (let day = 0; day < 3; day++) {
      now.value += DAY;
      await life.advanceTo(now.value);
    }
    const feels = life
      .events()
      .filter((event) => event.kind === "felt" && event.payload.about === "read:one")
      .map((event) => (event.kind === "felt" ? event.payload.valence : 0));
    assert.ok(feels.length >= 3, "she read it several times");
    assert.ok(feels[feels.length - 1]! < feels[0]!, "the same passage is less new each time");
  });

  it("wants something new when everything has been read", async () => {
    const now = { value: Date.parse("2026-11-01T05:30:00+08:00") };
    const life = await Life.open({
      genome: createGenome({
        ...ISLA_GENOME,
        temperament: { ...ISLA_GENOME.temperament, curiosity: 2 },
      }),
      world: createRoom({ seed: "want", books: [] }),
      archive: new MemoryArchive(),
      clock: () => now.value,
      activities: [],
    });
    // Nothing to do; after a few hours the need to see something new is loud enough.
    await life.advanceTo(now.value + 3 * HOUR);
    assert.ok(life.events().some((event) => event.kind === "wanted"), "she asked for something new");
  });
});
