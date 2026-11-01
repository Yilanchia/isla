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
  seededRandom,
  type Clarity,
  type GenomeInput,
  type LifeEvent,
  type Recollection,
} from "@isla/life";

/**
 * A year with someone who talks to her every day. Sixteen things worth remembering are said in
 * the first seven weeks, among a thousand-odd lines of small talk; then each is asked about 1, 7,
 * 30, 90, 180 and 360 days later, four ways. The log is deterministic, so these numbers only move
 * when the memory code does.
 */
const BIRTH = Date.parse("2026-11-01T06:30:00+08:00");
const ZONE = "Asia/Shanghai";
const AGES = [1, 7, 30, 90, 180, 360];
const OWNER = { personId: "owner", name: "主人" };
const KINDS = ["words", "topic", "when", "paraphrase"] as const;
type QueryKind = (typeof KINDS)[number];

interface Plant {
  text: string;
  /** The words it was said with. */
  words: string;
  /** Asked about the same thing with some of the same words. */
  topic: string;
  /** Asked with none of its words: what only a semantic match would find. */
  paraphrase: string;
  /** Looked up on purpose on days 2, 9 and 30 after it was said. */
  rehearse?: true;
}

const PLANTS: Plant[] = [
  { text: "我对花生过敏，以后买零食帮我看着点", words: "花生过敏", topic: "零食里有花生吗", paraphrase: "我不能吃什么来着", rehearse: true },
  { text: "我妈的生日是三月十二号", words: "我妈生日", topic: "给我妈准备生日礼物", paraphrase: "母亲哪天出生的" },
  { text: "公司 VPN 的账号是 fairy-ops，密码在 1Password 里", words: "VPN 账号", topic: "公司 VPN 连不上", paraphrase: "远程办公怎么登录" },
  { text: "那部肥皂剧叫《金色年华》，你也可以看看", words: "金色年华", topic: "那部肥皂剧叫什么", paraphrase: "上次推荐你的电视剧", rehearse: true },
  { text: "周末想去青岛看海", words: "青岛看海", topic: "上次说想去哪看海", paraphrase: "我想去的那个海边城市" },
  { text: "我在学日语，目标是明年考 N2", words: "日语 N2", topic: "我日语考试考几级", paraphrase: "我在准备什么外语考试" },
  { text: "车停在 B2 层 C 区 37 号", words: "B2 C 区", topic: "车停在哪个区", paraphrase: "我把车放哪了" },
  { text: "体检约在下个月 15 号上午", words: "体检", topic: "体检约的是几号", paraphrase: "医院检查是哪天" },
  { text: "老板姓周，脾气很急，周报要在周五前交", words: "周报", topic: "老板脾气怎么样", paraphrase: "领导是个什么样的人" },
  { text: "我喜欢喝冰美式，不加糖", words: "冰美式", topic: "我喝美式加不加糖", paraphrase: "帮我点杯咖啡" },
  { text: "家里的猫叫团子，三岁了", words: "团子", topic: "家里的猫叫什么", paraphrase: "我家宠物的名字", rehearse: true },
  { text: "护照下个月过期，记得提醒我去续", words: "护照", topic: "护照什么时候过期", paraphrase: "出国证件的事" },
  { text: "我对花粉也过敏，春天要备着药", words: "花粉过敏", topic: "春天要备什么药", paraphrase: "换季我容易怎样" },
  { text: "想换一台显示器，预算三千左右", words: "显示器预算", topic: "显示器预算多少", paraphrase: "我想买的电脑屏幕" },
  { text: "下周三要去上海出差两天", words: "上海出差", topic: "出差去哪", paraphrase: "我下次外地工作去哪" },
  { text: "女朋友叫小雅，在杭州工作", words: "小雅", topic: "女朋友在哪工作", paraphrase: "我对象在哪个城市" },
];

const SMALL_TALK = [
  "今天好累啊", "帮我看下明天天气", "中午吃了碗面", "开了一下午的会", "晚上想早点睡", "这个 bug 修了一天",
  "刚跑完步", "随便聊聊吧", "你在干嘛", "最近有点忙", "周末打算宅着", "地铁好挤", "今天下雨了",
  "帮我整理一下桌面", "有点想出去走走", "刚看完一集动漫", "今天心情还行", "早上起晚了", "这首歌挺好听",
  "好饿", "楼下新开了家店", "电脑有点卡", "明天要早起", "外面好冷", "刚洗完澡", "今天没什么事",
];
const REPLIES = ["嗯。", "知道了。", "好的。", "辛苦了。", "去吧。"];

const RANK: Record<Clarity | "gone", number> = { clear: 3, vague: 2, faint: 1, gone: 0 };

interface Tally {
  asked: number;
  found: number;
}

interface Report {
  deliberate: Record<QueryKind, Tally[]>;
  involuntary: Record<QueryKind, Tally[]>;
  clarity: Array<Record<Clarity | "gone", number>>;
  /** Clarity as 3 (clear) to 0 (gone), per age, for the rehearsed and the other plants. */
  rehearsedClarity: number[][];
  plainClarity: number[][];
  rehearsed: Tally[];
  plain: Tally[];
  ungrounded: number;
  factChars: number[];
  memoryChars: number[];
  events: number;
  memories: number;
  rebuildMs: number;
  recallMs: number;
}

function tallies(): Tally[] {
  return AGES.map(() => ({ asked: 0, found: 0 }));
}

function dateOf(at: number): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, month: "numeric", day: "numeric" }).formatToParts(new Date(at));
  return { month: Number(parts.find((p) => p.type === "month")?.value), day: Number(parts.find((p) => p.type === "day")?.value) };
}

/** The words an event holds of its own; a recollection of it must contain some of them. */
function ownWords(event: LifeEvent): string | undefined {
  switch (event.kind) {
    case "heard":
    case "said":
    case "wrote":
      return event.payload.text;
    case "reflected":
      return event.payload.diary;
    case "belief":
      return event.payload.statement;
    case "perceived":
      return event.payload.what;
    case "activity.started":
      return event.payload.label;
    case "felt":
      return event.payload.reason;
    default:
      return undefined;
  }
}

async function run(input: GenomeInput): Promise<Report> {
  const genome = createGenome(input);
  let now = BIRTH;
  const life = await Life.open({ genome, world: createRoom({ seed: "room" }), archive: new MemoryArchive(), clock: () => now, lifeId: "eval" });
  // Kept beside the life from its own event feed, so probing reads memory without touching it.
  const index = new MemoryIndex(memorySettings(life.state.genome));
  const byId = new Map<string, LifeEvent>();
  for (const event of life.events()) {
    index.add(event);
    byId.set(event.id, event);
  }
  life.subscribe((event) => {
    index.add(event);
    byId.set(event.id, event);
  });

  const report: Report = {
    deliberate: Object.fromEntries(KINDS.map((kind) => [kind, tallies()])) as Report["deliberate"],
    involuntary: Object.fromEntries(KINDS.map((kind) => [kind, tallies()])) as Report["involuntary"],
    clarity: AGES.map(() => ({ clear: 0, vague: 0, faint: 0, gone: 0 })),
    rehearsedClarity: AGES.map(() => []),
    plainClarity: AGES.map(() => []),
    rehearsed: tallies(),
    plain: tallies(),
    ungrounded: 0,
    factChars: [],
    memoryChars: [],
    events: 0,
    memories: 0,
    rebuildMs: 0,
    recallMs: 0,
  };
  const grounded = (items: Recollection[]) => {
    for (const item of items) {
      const event = byId.get(item.id);
      const words = event && ownWords(event);
      if (!event || (words !== undefined && !item.text.includes(words.slice(0, 4)))) report.ungrounded++;
    }
  };

  const random = seededRandom("small-talk");
  const steps: Array<{ at: number; act: () => Promise<void> }> = [];
  const talk = async (text: string) => {
    const { heard } = await life.listen({ ...OWNER, text });
    await life.speak({ personId: OWNER.personId, inReplyTo: heard.id, text: REPLIES[Math.floor(random() * REPLIES.length)]!, speaker: "eval" });
    return heard;
  };
  const span = 7 * 7 + 3 + Math.max(...AGES) + 1;
  for (let day = 0; day < span; day++) {
    for (const hour of [9, 13, 18, 21]) {
      steps.push({ at: BIRTH + day * DAY + hour * HOUR, act: async () => void (await talk(SMALL_TALK[Math.floor(random() * SMALL_TALK.length)]!)) });
    }
  }
  const planted = new Map<Plant, { id: string; at: number }>();
  PLANTS.forEach((plant, n) => {
    const at = BIRTH + (3 + n * 3) * DAY + (10 + (n % 9)) * HOUR;
    steps.push({ at, act: async () => void planted.set(plant, { id: (await talk(plant.text)).id, at }) });
    if (plant.rehearse) {
      for (const after of [2, 9, 30]) {
        steps.push({ at: at + after * DAY + 8 * HOUR, act: async () => void (await life.remember({ text: plant.words, ...OWNER })) });
      }
    }
    AGES.forEach((age, slot) => {
      steps.push({ at: at + age * DAY, act: async () => probe(plant, slot) });
    });
  });

  const probe = async (plant: Plant, slot: number) => {
    const target = planted.get(plant);
    if (!target) return;
    const { month, day } = dateOf(target.at);
    const queries: Record<QueryKind, string> = {
      words: plant.words,
      topic: plant.topic,
      when: `${month}月${day}日我们聊了什么`,
      paraphrase: plant.paraphrase,
    };
    let best: Clarity | "gone" = "gone";
    for (const kind of KINDS) {
      // Asked about a day, everything said that day is a right answer, so it gets the usual list.
      const limit = kind === "when" ? 8 : 3;
      const deliberate = index.recall({ text: queries[kind], personId: OWNER.personId, limit }, now, true);
      const started = performance.now();
      const involuntary = life.recall({ text: queries[kind], personId: OWNER.personId });
      report.recallMs = Math.max(report.recallMs, performance.now() - started);
      grounded(deliberate);
      grounded(involuntary);
      report.deliberate[kind][slot]!.asked++;
      report.involuntary[kind][slot]!.asked++;
      const hit = deliberate.find((item) => item.id === target.id);
      if (hit) report.deliberate[kind][slot]!.found++;
      const surfaced = involuntary.find((item) => item.id === target.id);
      if (surfaced) report.involuntary[kind][slot]!.found++;
      if (kind === "words") {
        const group = plant.rehearse ? report.rehearsed : report.plain;
        group[slot]!.asked++;
        if (surfaced) group[slot]!.found++;
        best = surfaced?.clarity ?? "gone";
      }
    }
    report.clarity[slot]![best]++;
    (plant.rehearse ? report.rehearsedClarity : report.plainClarity)[slot]!.push(RANK[best]);
    const facts = life.facts({ personId: OWNER.personId, cue: plant.topic });
    report.factChars.push(facts.reduce((sum, fact) => sum + fact.text.length, 0));
    report.memoryChars.push(facts.filter((fact) => fact.text.startsWith("你想起：")).reduce((sum, fact) => sum + fact.text.length, 0));
  };

  steps.sort((left, right) => left.at - right.at);
  for (const step of steps) {
    await life.advanceTo(step.at);
    now = step.at;
    await step.act();
  }
  report.events = life.events().length;
  const started = performance.now();
  const rebuilt = new MemoryIndex(memorySettings(life.state.genome));
  for (const event of life.events()) rebuilt.add(event);
  report.rebuildMs = performance.now() - started;
  report.memories = rebuilt.size;
  return report;
}

function percent(tally: Tally): string {
  return tally.asked === 0 ? "  -" : `${String(Math.round((100 * tally.found) / tally.asked)).padStart(3)}%`;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function format(name: string, report: Report): string {
  const head = `            ${AGES.map((age) => `${age}天`.padStart(5)).join(" ")}`;
  const row = (label: string, values: Tally[]) => `${label.padEnd(12)}${values.map((value) => ` ${percent(value)}`).join("")}`;
  return [
    `== ${name}: ${report.events} events, ${report.memories} memories, index rebuilt in ${Math.round(report.rebuildMs)} ms, slowest recall ${report.recallMs.toFixed(1)} ms`,
    "found on purpose (top 3; a date: in the list of 8)",
    head,
    ...KINDS.map((kind) => row(kind, report.deliberate[kind])),
    "came to mind on its own",
    head,
    ...KINDS.map((kind) => row(kind, report.involuntary[kind])),
    row("rehearsed", report.rehearsed),
    row("not", report.plain),
    `clarity on its own (words): ${report.clarity.map((c, i) => `${AGES[i]}天 ${c.clear}/${c.vague}/${c.faint}/${c.gone}`).join("  ")}  (clear/vague/faint/gone)`,
    `mean clarity, rehearsed vs not (3 clear … 0 gone): ${AGES.map((age, i) => `${age}天 ${mean(report.rehearsedClarity[i]!).toFixed(1)}/${mean(report.plainClarity[i]!).toFixed(1)}`).join("  ")}`,
    `ungrounded recollections: ${report.ungrounded}`,
    `facts per turn: median ${median(report.factChars)} chars, of which memories ${median(report.memoryChars)}`,
  ].join("\n");
}

describe("memory over a year", () => {
  it("finds what was said, lets the unused fade, and never makes anything up", async () => {
    const human = await run({ ...ISLA_GENOME });
    const butler = await run({ ...ISLA_GENOME, memory: { decay: 0.4, records: ["heard", "said"] } });
    console.log(`\n${format("human (decay 0.5)", human)}\n\n${format("butler (decay 0.4, keeps records)", butler)}\n`);

    for (const report of [human, butler]) {
      assert.equal(report.ungrounded, 0, "every recollection comes from an event and says what it said");
      const all = (tallies: Tally[]) => tallies.every((tally) => tally.found === tally.asked);
      // Searching on purpose, anything said with the same words is found, however old.
      assert.ok(all(report.deliberate.words) && all(report.deliberate.topic), "deliberate recall by words and topic");
      assert.ok(all(report.deliberate.when), "asked about a day, what was said that day is in the list");
      // Within half a year, the same words bring it back without looking.
      assert.ok(all(report.involuntary.words.slice(0, AGES.indexOf(180) + 1)), "involuntary recall within 180 days");
      // A time word on its own never makes something surface.
      assert.ok(report.involuntary.when.every((tally) => tally.found === 0));
      // Fresh memories are clear, and the unused ones do not stay that way.
      assert.equal(report.clarity[0]!.clear, PLANTS.length);
      assert.ok(!report.plainClarity[AGES.indexOf(180)]!.includes(RANK.clear), "nothing unrehearsed is word for word after half a year");
      // What was looked up again stays clearer than what was not.
      const at90 = AGES.indexOf(90);
      assert.ok(mean(report.rehearsedClarity[at90]!) > mean(report.plainClarity[at90]!), "rehearsal keeps memories clearer");
      // Each turn's facts stay small, whatever her age.
      assert.ok(Math.max(...report.factChars) < 3000, `facts per turn ${Math.max(...report.factChars)} chars`);
    }
    // A lower decay keeps things clearer for longer.
    const meanAt = (report: Report, age: number) => mean([...report.rehearsedClarity[AGES.indexOf(age)]!, ...report.plainClarity[AGES.indexOf(age)]!]);
    assert.ok(meanAt(butler, 30) > meanAt(human, 30));
  });
});
