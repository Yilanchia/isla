import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVITIES, shelfActivity } from "./activities.js";
import { DAY, HOUR } from "./clock.js";
import { MemoryArchive } from "./events.js";
import { createGenome, ISLA_GENOME } from "./genome.js";
import { Life } from "./life.js";
import { InnerMind } from "./mind.js";
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

  it("keeps a promise to someone", async () => {
    const now = { value: Date.parse("2026-11-01T05:30:00+08:00") };
    const life = await Life.open({
      genome: ISLA_GENOME,
      world: createRoom({ seed: "promise", books: [] }),
      archive: new MemoryArchive(),
      clock: () => now.value,
    });
    await life.advanceTo(now.value + HOUR);
    const heard = await life.hear({ personId: "p1", name: "阿岚", text: "帮我把护照找出来" });
    await life.note({
      personId: "p1",
      topic: "护照",
      text: "帮她找护照",
      source: heard.heard.id,
      pending: true,
    });

    // By bedtime she takes it on.
    now.value += 20 * HOUR;
    await life.advanceTo(now.value);
    const aimed = life.events().filter((event) => event.kind === "aimed" && event.payload.kind === "do-for");
    assert.ok(aimed.length > 0, "a promise became a goal");

    // The promise is closed; so is the goal.
    await life.note({
      personId: "p1",
      topic: "护照",
      text: "护照找到了",
      source: heard.heard.id,
      done: true,
    });
    const achieved = life.events().filter((event) => event.kind === "achieved");
    assert.ok(achieved.length > 0, "closing the promise finished the goal");

    const rebuilt = replay(life.events());
    assert.ok(rebuilt);
    assert.deepEqual(rebuilt.goals, life.state.goals);
  });

  it("writes a piece about a book she finished", async () => {
    const now = { value: Date.parse("2026-11-01T05:30:00+08:00") };
    const shortBook = {
      id: "short",
      title: "短书",
      passages: Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 段`),
    };
    const genome = createGenome({ ...ISLA_GENOME, chronotype: { wakeHour: 9, sleepHour: 19 } });
    const life = await Life.open({
      genome,
      world: createRoom({ seed: "make", books: [shortBook] }),
      archive: new MemoryArchive(),
      clock: () => now.value,
      activities: ACTIVITIES.filter((kind) => kind.id === "read" || kind.id === "write"),
    });
    for (let day = 0; day < 8; day++) {
      now.value += DAY;
      await life.advanceTo(now.value);
    }
    const made = life.events().filter((event) => event.kind === "made");
    assert.equal(made.length, 1, "she wrote one piece");
    assert.match(made[0]?.payload.title ?? "", /写一篇关于/u);
    const rebuilt = replay(life.events());
    assert.ok(rebuilt);
    assert.deepEqual(rebuilt.goals, life.state.goals);
  });

  it("looks further into something she keeps coming back to", async () => {
    const now = { value: Date.parse("2026-11-01T05:30:00+08:00") };
    const news = shelfActivity({ id: "news", label: "看新闻", verb: "读到" });
    const life = await Life.open({
      genome: ISLA_GENOME,
      world: createRoom({ seed: "learn", books: [] }),
      archive: new MemoryArchive(),
      clock: () => now.value,
      activities: [...ACTIVITIES, news],
    });
    for (let index = 0; index < 6; index++) {
      await life.stock({
        shelf: "news",
        item: `a${index}`,
        title: `AI ${index}`,
        text: `关于 AI 的第 ${index} 条`,
        tags: ["AI"],
        source: "test",
      });
    }
    for (let day = 0; day < 8; day++) {
      now.value += DAY;
      await life.advanceTo(now.value);
    }
    const aimed = life.events().filter((event) => event.kind === "aimed" && event.payload.kind === "learn");
    assert.ok(aimed.length > 0, "a taste became a goal");
    const achieved = life.events().filter((event) => event.kind === "achieved");
    assert.ok(achieved.length > 0, "she looked into it enough");
    const rebuilt = replay(life.events());
    assert.ok(rebuilt);
    assert.deepEqual(rebuilt.goals, life.state.goals);
  });

  it("writes a goal into her diary", async () => {
    const mind = new InnerMind();
    const response = await mind.compose({
      task: "diary",
      name: "艾拉",
      voice: "",
      day: "2026-11-02",
      facts: [
        { id: "e49", kind: "goal", words: "read:long", text: "你正在做：读完《长书》" },
        { id: "state:mood", kind: "mood", words: "心情不错", text: "你现在心情不错" },
      ],
    });
    assert.match(response.text, /读完《长书》/u);
  });
});
