import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVITIES,
  createRoom,
  DAY,
  formatVitals,
  HOUR,
  ISLA_GENOME,
  Life,
  measureLife,
  MemoryArchive,
  shelfActivity,
  type Vitals,
} from "@isla/life";

/**
 * A month of her life, measured. The first milestone ("a day alone") asked whether she can
 * live a day and account for it. This one asks whether she is still living on day 30 or only
 * repeating day 3.
 *
 * Two months are lived: one completely alone in the sample room, and one where the host puts an
 * article on her shelf every morning. Targets she cannot meet yet are `todo`: they run and
 * report, so the numbers are visible on every run, but do not fail the build until the kernel
 * is meant to meet them.
 */
const BIRTH = Date.parse("2026-11-01T05:30:00+08:00");
const DAYS = 30;
const TOPICS = [["AI"], ["天气", "城市"], ["诗"], ["AI", "开源"], ["音乐"], ["城市"], ["开源"]];

async function liveAMonth(fed: boolean): Promise<Vitals> {
  let now = BIRTH;
  const news = shelfActivity({ id: "news", label: "看新闻", verb: "读到" });
  const life = await Life.open({
    genome: ISLA_GENOME,
    world: createRoom({ seed: "room" }),
    archive: new MemoryArchive(),
    clock: () => now,
    lifeId: fed ? "fed" : "alone",
    ...(fed ? { activities: [...ACTIVITIES, news] } : {}),
  });
  for (let day = 0; day < DAYS; day++) {
    const morning = BIRTH + day * DAY + 2 * HOUR;
    await life.advanceTo(morning);
    now = morning;
    if (fed) {
      await life.stock({
        shelf: "news",
        item: `d${day}`,
        title: `第 ${day + 1} 天的文章`,
        text: `关于${TOPICS[day % TOPICS.length]!.join("和")}的一篇文章`,
        tags: TOPICS[day % TOPICS.length]!,
        source: "订阅",
      });
    }
  }
  await life.advanceTo(BIRTH + DAYS * DAY);
  return measureLife(life.events());
}

const months = { alone: liveAMonth(false), fed: liveAMonth(true) };

function weekFour(vitals: Vitals) {
  const week = vitals.weeks.find((item) => item.week === 4);
  assert.ok(week, "a fourth week was lived");
  return week;
}

describe("a month", () => {
  it("is measured from the log, week by week", async () => {
    for (const [name, month] of Object.entries(months)) {
      const vitals = await month;
      console.log(`\n${name}\n${formatVitals(vitals)}`);
      assert.ok(vitals.weeks.length >= 4);
      // Everything is new at first; this checks the measure, not her.
      assert.ok(vitals.weeks[0]!.diaryNovelty > 0.3 && vitals.weeks[0]!.firsts > 5);
    }
  });

  it("brings her new things when the host keeps her shelf stocked", async () => {
    assert.ok(weekFour(await months.fed).firsts >= 5);
  });

  // Targets for the next stretch of work. Baseline at the time of writing, alone / fed, week 4:
  // diary novelty 0.01 / 0.03, note novelty 0.00 / 0.00, belief changes after week 1: 0 / 3,
  // days of unmet need spent in a good mood over the month: 28 / 28. Note that fed, she meets
  // something new every day and it still does not reach her diary or her notebook.

  it("still says new things in her diary in week 4", { todo: "goals and habituation" }, async () => {
    for (const month of Object.values(months)) assert.ok(weekFour(await month).diaryNovelty >= 0.25);
  });

  it("does not repeat herself in her notebook", { todo: "habituation, and a mind that writes" }, async () => {
    for (const month of Object.values(months)) assert.ok(weekFour(await month).noteNovelty >= 0.5);
  });

  it("still finds things out about herself after the first week", { todo: "goals" }, async () => {
    for (const month of Object.values(months)) {
      const later = (await month).weeks.filter((week) => week.week > 1);
      assert.ok(later.reduce((sum, week) => sum + week.beliefChanges, 0) >= 3);
    }
  });

  it("is not in a good mood after days of wanting company and getting none", { todo: "chronic states" }, async () => {
    for (const month of Object.values(months)) {
      assert.equal((await month).weeks.reduce((sum, week) => sum + week.unmetButFineDays, 0), 0);
    }
  });

  it("finishes something she set out to do", async () => {
    for (const month of Object.values(months)) {
      const done = (await month).weeks.reduce((sum, week) => sum + week.goalsAchieved, 0);
      assert.ok(done >= 1, "at least one goal was finished in the month");
    }
  });
});
