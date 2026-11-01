import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGenome,
  createRoom,
  DAY,
  HOUR,
  ISLA_GENOME,
  Life,
  MemoryArchive,
  MemoryIndex,
  memorySettings,
  parseWhen,
  tokenize,
  type LifeEvent,
  type MemorySettings,
} from "./index.js";

/** Tuesday 2026-12-01 09:30 in Shanghai. */
const NOW = Date.parse("2026-12-01T09:30:00+08:00");
const T0 = Date.parse("2026-11-01T10:00:00+08:00");
const ZONE = "Asia/Shanghai";

function settings(decay = 0.5, records: string[] = []): MemorySettings {
  return { decay, records: new Set(records), timezone: ZONE };
}

/** A hand-built log: memory only reads events, so it can be tested without living a life. */
class Log {
  readonly events: LifeEvent[] = [];
  heard(at: number, text: string): string {
    return this.push({ at, kind: "heard", causes: [], payload: { personId: "owner", name: "主人", text } });
  }
  wrote(at: number, text: string): string {
    return this.push({ at, kind: "wrote", causes: [], payload: { text, mind: "inner", grounds: [], rejected: [], facts: {} } });
  }
  recalled(at: number, found: string[]): string {
    return this.push({ at, kind: "recalled", causes: [], payload: { cue: "", found } });
  }
  index(memory = settings()): MemoryIndex {
    const index = new MemoryIndex(memory);
    for (const event of this.events) index.add(event);
    return index;
  }
  private push(draft: Omit<LifeEvent, "id" | "seq">): string {
    const seq = this.events.length + 1;
    const event = { ...draft, id: `e${seq}`, seq } as LifeEvent;
    this.events.push(event);
    return event.id;
  }
}

describe("finding words", () => {
  it("keeps the words that carry meaning and pairs up a name the dictionary splits", () => {
    const terms = tokenize("主人说他对花生过敏，艾拉也知道");
    assert.ok(terms.includes("花生") && terms.includes("过敏") && terms.includes("艾拉"));
    assert.ok(!terms.includes("说") && !terms.includes("他") && !terms.includes("说他"));
  });

  it("understands the time words people use", () => {
    const day = (text: string) => {
      const found = parseWhen(text, NOW, ZONE);
      return found && new Date(found.range.from).toLocaleDateString("sv", { timeZone: ZONE });
    };
    assert.equal(day("昨天聊的"), "2026-11-30");
    assert.equal(day("上周三那部剧"), "2026-11-25");
    assert.equal(day("三天前"), "2026-11-28");
    assert.equal(day("11月4日说了什么"), "2026-11-04");
    assert.equal(day("上个月"), "2026-11-01");
    // "下周五" is ahead: nothing to remember there yet.
    assert.equal(parseWhen("下周五要交报告", NOW, ZONE), undefined);
    assert.equal(parseWhen("上周三那部剧", NOW, ZONE)?.rest.trim(), "那部剧");
  });
});

describe("fading and staying", () => {
  it("fades a memory nobody uses, and keeps one that is used", () => {
    const log = new Log();
    const left = log.heard(T0, "我对花生过敏");
    const kept = log.heard(T0, "周末想去青岛看海");
    for (const day of [3, 10, 20]) log.recalled(T0 + day * DAY, [kept]);
    const index = log.index();
    const early = index.strength(left, T0 + 2 * HOUR)!;
    const late = index.strength(left, T0 + 30 * DAY)!;
    assert.ok(late < early - 2, `${early} → ${late}`);
    assert.ok(index.strength(kept, T0 + 30 * DAY)! > late + 1);
  });

  it("keeps what was gone over on different days longer than what was crammed in one sitting", () => {
    const log = new Log();
    const crammed = log.heard(T0, "季度报告下周五交");
    const spaced = log.heard(T0, "体检约在月底");
    for (const minute of [0, 1, 2]) log.recalled(T0 + 2 * DAY + minute * 60_000, [crammed]);
    for (const day of [2, 9, 16]) log.recalled(T0 + day * DAY, [spaced]);
    const index = log.index();
    // Right after the cramming it is the stronger one; a fortnight later it is not.
    assert.ok(index.strength(crammed, T0 + 2 * DAY + 5 * 60_000)! > index.strength(spaced, T0 + 2 * DAY + 5 * 60_000)!);
    assert.ok(index.strength(spaced, T0 + 30 * DAY)! > index.strength(crammed, T0 + 30 * DAY)!);
  });

  it("forgets more slowly with a lower decay in the genome", () => {
    const log = new Log();
    const id = log.heard(T0, "那部肥皂剧叫《金色年华》");
    const human = log.index(settings(0.5)).strength(id, T0 + 60 * DAY)!;
    const machine = log.index(settings(0.3)).strength(id, T0 + 60 * DAY)!;
    assert.ok(machine > human + 1, `${human} vs ${machine}`);
  });
});

describe("coming back", () => {
  it("brings a memory back on its own only when the cue shares a word with it", () => {
    const log = new Log();
    log.heard(T0, "我对花生过敏");
    const index = log.index();
    const at = T0 + 20 * HOUR;
    assert.equal(index.recall({ text: "今天天气不错" }, at).length, 0);
    // A time word alone is not enough to make something surface by itself.
    assert.equal(index.recall({ text: "昨天" }, at).length, 0);
    assert.equal(index.recall({ text: "零食里有花生吗" }, at)[0]?.clarity, "vague");
  });

  it("lets go of old memories on their own, but finds them when she searches", () => {
    const log = new Log();
    const id = log.heard(T0, "我对花生过敏");
    const index = log.index();
    const year = T0 + 365 * DAY;
    assert.equal(index.recall({ text: "花生" }, year).length, 0);
    const found = index.recall({ text: "花生" }, year, true);
    assert.equal(found[0]?.id, id);
    assert.equal(found[0]?.clarity, "faint");
    assert.match(found[0]!.text, /^记不太清了/u);
  });

  it("keeps an exact record of the kinds the genome says, when she searches on purpose", () => {
    const log = new Log();
    log.heard(T0, "我对花生过敏，以后买零食帮我看着点");
    log.wrote(T0, "花生酱的味道我不太记得了");
    const index = log.index(settings(0.5, ["heard"]));
    const found = index.recall({ text: "花生" }, T0 + 365 * DAY, true);
    const heard = found.find((item) => item.kind === "heard");
    const wrote = found.find((item) => item.kind === "wrote");
    assert.equal(heard?.clarity, "clear");
    assert.match(heard!.text, /帮我看着点$/u);
    assert.equal(wrote?.clarity, "faint");
  });

  it("narrows a search to the day she is asked about", () => {
    const log = new Log();
    log.heard(Date.parse("2026-11-04T11:00:00+08:00"), "周末想去青岛看海");
    log.heard(Date.parse("2026-11-09T11:00:00+08:00"), "那部剧挺好看");
    const found = log.index().recall({ text: "11月4日我们聊了什么" }, NOW, true);
    assert.deepEqual(found.map((item) => item.id), ["e1"]);
    // Hazy as it is, she knows which day she was asked about.
    assert.match(found[0]!.text, /11月4日/u);
  });

  it("is the same memory when rebuilt from the same log", () => {
    const log = new Log();
    for (let day = 0; day < 30; day++) log.heard(T0 + day * DAY, `第${day}天说起花生和青岛`);
    log.recalled(T0 + 31 * DAY, ["e3", "e7"]);
    const cue = { text: "花生 青岛", limit: 10 };
    assert.deepEqual(log.index().recall(cue, NOW, true), log.index().recall(cue, NOW, true));
  });
});

describe("in a life", () => {
  it("brings back an old conversation when it comes up, and a search keeps it", async () => {
    const birth = Date.parse("2026-11-01T05:30:00+08:00");
    let now = birth;
    const genome = createGenome({ ...ISLA_GENOME, memory: { decay: 0.5, records: ["heard", "said"] } });
    const life = await Life.open({ genome, world: createRoom({ seed: "room" }), archive: new MemoryArchive(), clock: () => now, lifeId: "m" });
    const at = async (time: number) => {
      await life.advanceTo(time);
      now = time;
    };
    await at(birth + DAY + 5 * HOUR);
    const { heard } = await life.listen({ personId: "owner", name: "主人", text: "我对花生过敏，以后买零食帮我看着点" });
    await at(birth + 21 * DAY + 4 * HOUR);
    // Enough talk since then that it is no longer part of the recent exchange.
    for (let turn = 0; turn < 10; turn++) {
      await life.listen({ personId: "owner", name: "主人", text: `第${turn}件小事` });
    }

    const facts = life.facts({ personId: "owner", cue: "零食里有没有花生" });
    const memory = facts.find((fact) => fact.id === heard.id);
    assert.ok(memory, "the old conversation is among the facts");
    assert.match(memory.text, /^你想起：.*花生过敏/u);
    assert.ok(!life.facts({ personId: "owner", cue: "今天天气怎么样" }).some((fact) => fact.id === heard.id));

    const strengthOf = () => life.recall({ text: "花生", personId: "owner" }).find((item) => item.id === heard.id)!;
    const before = strengthOf();
    assert.notEqual(before.clarity, "clear");
    const found = await life.remember({ text: "花生", personId: "owner" });
    assert.equal(found[0]?.id, heard.id);
    assert.equal(found[0]?.clarity, "clear");
    const recalled = life.events().at(-1);
    assert.ok(recalled?.kind === "recalled" && recalled.payload.found.includes(heard.id));
    await at(now + 2 * DAY);
    const after = strengthOf();
    assert.ok(after.strength > before.strength, `${before.strength} → ${after.strength}`);
  });

  it("opens a life born before memory was in the genome", () => {
    const old = structuredClone(ISLA_GENOME) as Partial<typeof ISLA_GENOME>;
    delete old.memory;
    const memory = memorySettings(old as typeof ISLA_GENOME);
    assert.equal(memory.decay, 0.5);
    assert.equal(memory.records.size, 0);
  });
});
