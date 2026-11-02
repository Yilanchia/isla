import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVITIES,
  advance,
  createRoom,
  DAY,
  HOUR,
  ISLA_GENOME,
  Life,
  MemoryArchive,
  replay,
  shelfActivity,
  type LifeEvent,
} from "./index.js";

const BIRTH = Date.parse("2026-11-01T05:30:00+08:00");
const news = shelfActivity({ id: "news", label: "看新闻", verb: "读到" });

async function open(options: { reachOut?: boolean } = {}) {
  let now = BIRTH;
  const life = await Life.open({
    genome: ISLA_GENOME,
    world: createRoom({ seed: "room", books: [] }),
    archive: new MemoryArchive(),
    clock: () => now,
    lifeId: "s",
    // No books on her shelf: her own pastimes are the news, writing and resting.
    activities: [...ACTIVITIES.filter((kind) => kind.id !== "read"), news],
    ...(options.reachOut ? { reachOut: { personIds: ["owner"] } } : {}),
  });
  const at = async (time: number) => {
    await life.advanceTo(time);
    now = time;
  };
  return { life, at, now: () => now };
}

const article = (n: number, tags: string[]) => ({
  shelf: "news",
  item: `a${n}`,
  title: `文章 ${n}`,
  text: `第 ${n} 篇的摘要`,
  tags,
  source: "测试订阅",
});

const started = (life: Life) =>
  life.events().filter((event): event is LifeEvent<"activity.started"> => event.kind === "activity.started");
const urged = (life: Life) => life.events().filter((event): event is LifeEvent<"urged"> => event.kind === "urged");
const said = (life: Life) => life.events().filter((event): event is LifeEvent<"said"> => event.kind === "said");

describe("her shelves", () => {
  it("gets to what was put on a shelf in her own time, each thing once", async () => {
    const { life, at } = await open();
    for (let n = 0; n < 6; n++) assert.ok(await life.stock(article(n, ["AI"])));
    assert.equal(await life.stock(article(0, ["AI"])), undefined, "already waiting");
    await at(BIRTH + 16 * HOUR);
    const read = started(life).filter((event) => event.payload.activity === "news");
    assert.ok(read.length >= 3, `read ${read.length}`);
    const items = read.map((event) => (event.payload.material?.kind === "item" ? event.payload.material.item : ""));
    assert.deepEqual(items, [...new Set(items)], "never the same item twice");
    assert.equal(await life.stock(article(Number(items[0]!.slice(1)), ["AI"])), undefined, "already read");
    assert.equal(life.state.shelves.news?.length, 6 - read.length);
    const rebuilt = replay(life.events());
    assert.ok(rebuilt);
    assert.deepEqual(advance(rebuilt, life.state.at), life.state);
  });

  it("with nothing on the shelf, she does something else", async () => {
    const { life, at } = await open();
    await at(BIRTH + 12 * HOUR);
    assert.equal(started(life).filter((event) => event.payload.activity === "news").length, 0);
    assert.ok(started(life).length > 0);
  });

  it("comes to like some subjects and not others, and reaches for what she likes", async () => {
    const { life, at } = await open();
    for (let day = 0; day < 10; day++) {
      await at(BIRTH + day * DAY + 2 * HOUR);
      for (let n = 0; n < 4; n++) {
        await life.stock(article(day * 10 + n, [n % 2 === 0 ? "芯片" : "足球"]));
      }
    }
    await at(BIRTH + 11 * DAY);
    const beliefs = Object.values(life.state.beliefs).map((belief) => belief.statement);
    assert.ok(beliefs.some((statement) => /芯片|足球|看新闻/u.test(statement)), beliefs.join(" / "));
    const found = life.recall({ text: "文章 摘要" });
    assert.ok(found.length > 0, "what she read is part of her memory");
  });

  it("knows what is still waiting on her shelves, and when she sleeps", async () => {
    const { life } = await open();
    for (let n = 0; n < 5; n++) await life.stock(article(n, ["AI"]));
    const facts = life.facts().map((fact) => fact.text);
    assert.ok(facts.some((text) => /^看新闻：还有 5 样没看，最新的是「文章 4」（测试订阅）/u.test(text)), facts.join("\n"));
    assert.ok(facts.some((text) => /每天 23:00 左右睡下，7:00 左右醒来/u.test(text)));
  });
});

describe("a real sky", () => {
  async function hostSky() {
    let now = BIRTH;
    const life = await Life.open({
      genome: ISLA_GENOME,
      world: createRoom({ seed: "room", books: [], sky: "host" }),
      archive: new MemoryArchive(),
      clock: () => now,
      lifeId: "sky",
    });
    return { life, at: async (time: number) => { await life.advanceTo(time); now = time; } };
  }

  it("makes up no weather when the host owns the sky, and sees only what it reports", async () => {
    const { life, at } = await hostSky();
    await at(BIRTH + 12 * HOUR);
    const weatherOf = () => life.events().filter((event) => event.kind === "perceived" && event.payload.source === "weather");
    assert.equal(weatherOf().length, 0, "nothing invented");
    assert.ok(!started(life).some((event) => event.payload.activity === "gaze"), "nothing to look at yet");

    const rain = await life.perceive({ source: "weather", what: "成都下起了小雨", detail: "小雨" });
    assert.ok(rain);
    assert.equal(life.state.weather, "小雨");
    assert.equal(await life.perceive({ source: "weather", what: "成都还在下小雨", detail: "小雨" }), undefined, "the same sky is not news");
    await at(BIRTH + 16 * HOUR);
    const gazes = started(life).filter((event) => event.payload.activity === "gaze");
    for (const gaze of gazes) {
      assert.ok(gaze.payload.material?.kind === "view" && /雨点/u.test(gaze.payload.material.text), "she sees the rain that was reported");
    }
    assert.ok(life.facts().some((fact) => fact.text.includes("成都下起了小雨")));
  });

  it("keeps the weather source to itself when the world owns the sky", async () => {
    const { life } = await open();
    await assert.rejects(life.perceive({ source: "weather", what: "下雪了", detail: "雪" }), /keeps for itself/u);
  });
});

describe("reaching out", () => {
  it("never reaches out to anyone the host did not name", async () => {
    const { life, at } = await open();
    await life.listen({ personId: "owner", name: "主人", text: "我出门了" });
    await at(BIRTH + 3 * DAY);
    assert.equal(urged(life).length, 0);
  });

  it("wants to talk when she misses them, once, and waits for an answer before wanting again", async () => {
    const { life, at } = await open({ reachOut: true });
    await at(BIRTH + 2 * HOUR);
    await life.listen({ personId: "owner", name: "主人", text: "我出差几天" });
    await at(BIRTH + 3 * DAY);
    const urges = urged(life);
    assert.equal(urges.length, 1, urges.map((event) => `${event.payload.why}:${event.payload.about}`).join(" / "));
    assert.equal(urges[0]?.payload.why, "missed");
    // The host says it with speak(), against the urge.
    await life.speak({ personId: "owner", inReplyTo: urges[0]!.id, text: "主人，出差顺利吗？", speaker: "test" });
    assert.ok(said(life).some((event) => event.payload.inReplyTo === urges[0]!.id));
  });

  it("brings up what she still owes them first", async () => {
    const { life, at } = await open({ reachOut: true });
    await at(BIRTH + 2 * HOUR);
    const { heard } = await life.listen({ personId: "owner", name: "主人", text: "提醒我续护照" });
    await life.note({ personId: "owner", topic: "护照", text: "提醒主人续护照", source: heard.id, pending: true });
    await at(BIRTH + 8 * HOUR);
    const first = urged(life)[0];
    assert.equal(first?.payload.why, "pending");
    assert.match(first!.payload.about, /护照/u);
  });

  it("does not reach out while they are talking to her, or in her sleep", async () => {
    const { life, at } = await open({ reachOut: true });
    for (let hour = 2; hour < 14; hour++) {
      await at(BIRTH + hour * HOUR);
      await life.listen({ personId: "owner", name: "主人", text: "在吗" });
    }
    assert.equal(urged(life).length, 0);
    await at(BIRTH + 3 * DAY);
    for (const urge of urged(life)) {
      const hour = new Date(urge.at).getUTCHours() + 8;
      assert.ok(hour % 24 >= 7 && hour % 24 < 23, `urged at ${hour % 24}:00`);
    }
  });
});
