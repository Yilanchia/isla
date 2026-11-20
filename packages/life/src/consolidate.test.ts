import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoom, DAY, HOUR, ISLA_GENOME, Life, MemoryArchive, type LifeEvent } from "./index.js";

/** Sunday 2026-11-01 05:30 in Shanghai. */
const BIRTH = Date.parse("2026-11-01T05:30:00+08:00");

async function live(days: number, archive = new MemoryArchive()) {
  let now = BIRTH;
  const life = await Life.open({ genome: ISLA_GENOME, world: createRoom({ seed: "room" }), archive, clock: () => now, lifeId: "c" });
  const at = async (time: number) => {
    await life.advanceTo(time);
    now = time;
  };
  // The afternoon of her first day, someone talks to her.
  await at(BIRTH + 9 * HOUR);
  const { heard } = await life.listen({ personId: "owner", name: "主人", text: "周末想去青岛看海" });
  await life.speak({ personId: "owner", inReplyTo: heard.id, text: "去吧。", speaker: "test" });
  await at(BIRTH + days * DAY);
  return { life, archive, heard, at };
}

const episodes = (events: LifeEvent[]) => events.filter((event): event is LifeEvent<"episode"> => event.kind === "episode");
const chapters = (events: LifeEvent[]) => events.filter((event): event is LifeEvent<"chapter"> => event.kind === "chapter");

describe("sleep sorts the day", () => {
  it("turns a day into a few stretches, in order, each standing for the events in it", async () => {
    const { life, heard } = await live(1);
    const day = episodes(life.events()).filter((event) => event.payload.day === "2026-11-01");
    assert.ok(day.length >= 2 && day.length <= 4, `${day.length} episodes`);
    const parts = day.map((event) => event.payload.part);
    assert.deepEqual(parts, [...new Set(parts)]);
    for (const [index, episode] of day.entries()) {
      assert.ok(episode.payload.covers.length > 0);
      assert.ok(episode.payload.kept.every((id) => episode.payload.covers.includes(id)), "a summary mentions only what it stands for");
      if (index > 0) assert.ok(episode.payload.from >= day[index - 1]!.payload.to);
    }
    const afternoon = day.find((event) => event.payload.covers.includes(heard.id));
    assert.equal(afternoon?.payload.part, "下午");
    assert.match(afternoon!.payload.summary, /和主人说了 1 次话，说到「周末想去青岛看海」/u);
  });

  it("writes each week and the month once, and a restart does not write them again", async () => {
    const { life, archive } = await live(32);
    const written = chapters(life.events());
    const labels = written.map((event) => event.payload.label);
    assert.deepEqual(labels, [...new Set(labels)]);
    assert.ok(labels.includes("11月23日到11月29日"));
    assert.ok(labels.includes("2026年11月"));
    const month = written.find((event) => event.payload.span === "month")!;
    assert.ok(month.payload.covers.length >= 28, "the month stands for its episodes");
    assert.match(month.payload.summary, /读/u);

    const count = life.events().length;
    const reopened = await Life.open({ genome: ISLA_GENOME, world: createRoom({ seed: "room" }), archive, clock: () => BIRTH + 32 * DAY, lifeId: "c" });
    await reopened.advanceTo(BIRTH + 32 * DAY);
    assert.equal(reopened.events().length, count);
  });

  it("answers a question about a week or a month with that week or month", async () => {
    const { life } = await live(32);
    // 2026-12-03, a Thursday.
    const week = await life.remember({ text: "上周过得怎么样" });
    assert.equal(week[0]?.kind, "chapter");
    assert.match(week[0]!.text, /^11月23日到11月29日：/u);
    const month = await life.remember({ text: "上个月都做了什么" });
    assert.match(month[0]!.text, /^2026年11月：/u);
    const day = await life.remember({ text: "11月1日下午" });
    assert.ok(day.some((item) => item.kind === "episode"));
  });

  it("keeps the last week and the last month among the facts, one line each", async () => {
    const { life } = await live(32);
    const facts = life.facts();
    assert.equal(facts.filter((fact) => fact.text.startsWith("最近一周")).length, 1);
    assert.equal(facts.filter((fact) => fact.text.startsWith("最近一个月（2026年11月）")).length, 1);
  });

  it("still finds what was said by its words before any summary that quotes it", async () => {
    const { life, heard } = await live(10);
    const found = await life.remember({ text: "青岛看海" });
    assert.equal(found[0]?.id, heard.id);
    assert.ok(found.some((item) => item.kind === "episode"));
  });
});
