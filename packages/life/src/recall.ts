import { localTime } from "@isla/core";
import { DAY, HOUR, localMidnight } from "./clock.js";
import type { LifeEvent } from "./events.js";
import { whenLabel } from "./facts.js";
import type { Genome } from "./genome.js";

/**
 * How well she remembers something right now. It comes from how often and how recently the
 * memory was used, never from a model.
 */
export type Clarity = "clear" | "vague" | "faint";

/** One memory, rendered at the clarity she has it with. `id` is the event it comes from. */
export interface Recollection {
  id: string;
  at: number;
  kind: LifeEvent["kind"];
  clarity: Clarity;
  /** What she can say about it: full wording when clear, a gist when vague, a hint when faint. */
  text: string;
  /** Base-level activation: how alive the memory is on its own. */
  strength: number;
  /** How well the cue matched, 0 to 1. */
  match: number;
}

export interface RecallCue {
  /** Words that bring it back, usually what was just said. Time words ("上周三") are understood. */
  text?: string;
  /** Who she is talking to; their memories come back a little more easily. */
  personId?: string;
  /** Restricts recall to a span of time, e.g. one day. Overrides time words in `text`. */
  from?: number;
  to?: number;
  limit?: number;
  /** Ids already in front of her, which need not come back. */
  exclude?: ReadonlySet<string>;
}

export interface MemorySettings {
  /** ACT-R decay `d`. */
  decay: number;
  /** Event kinds she keeps an exact record of: searched for on purpose, they are always clear. */
  records: ReadonlySet<string>;
  timezone: string;
}

export function memorySettings(genome: Genome): MemorySettings {
  // Lives born before the genome had a memory section use the defaults.
  const memory = (genome as Partial<Genome>).memory;
  return {
    decay: memory?.decay ?? 0.5,
    records: new Set(memory?.records ?? []),
    timezone: genome.timezone,
  };
}

/**
 * Above CLEAR she remembers it word for word; below FAINT only a hint is left. Something said
 * once and gone over in that night's diary is, at decay 0.5, clear for about five days and vague
 * for about three months; at 0.4, clear for about ten days and vague for over a year.
 */
const CLEAR = -1;
const FAINT = -2.5;
/** What a memory needs, strength plus cue, to come to mind without being looked for. */
const RETRIEVAL = -0.5;
const MATCH_WEIGHT = 3;
const PERSON_BONUS = 0.4;
const TIME_BONUS = 1;
const TALK_BONUS = 0.5;
const FIT_BONUS = 2;
const SUMMARY_PENALTY = 0.5;
const TALK_WORDS = /聊|说|谈|讲|告诉|提过|问过|答应|交代|约好/u;
const SPREAD = 0.3;
/** A memory linked to more than this many others (a diary) does not pass activation on. */
const SPREAD_MAX_LINKS = 8;
const SALIENCE_PER_VALENCE = 4;
/** Pavlik & Anderson's `c`; the genome's decay stands in for their intercept `α`. */
const SPACING = 0.2;
const MIN_DECAY = 0.1;
const MAX_DECAY = 0.9;
const MIN_AGE_HOURS = 1 / 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Some kinds of things stay with her more than others, whatever she felt about them. */
const KIND_WEIGHT: Partial<Record<LifeEvent["kind"], number>> = {
  born: 1,
  chapter: 0.5,
  episode: 0.2,
  // She chose to keep it.
  noted: 0.8,
  heard: 0.3,
  said: 0.3,
  belief: 0.5,
  reflected: 0.2,
  wrote: 0.1,
};

interface Use {
  at: number;
  decay: number;
}

interface Trace {
  id: string;
  at: number;
  kind: LifeEvent["kind"];
  personId?: string;
  lead: string;
  body: string;
  length: number;
  /** For episodes and chapters: how long a span of time they sum up. */
  span?: number;
  /**
   * When the memory was formed and every time it was used since, oldest first, each with its own
   * decay: a use while the memory is still fresh fades faster (Pavlik & Anderson, 2005).
   */
  uses: Use[];
  salience: number;
  links: string[];
}

/**
 * Her memory: an index over the life log, never a second copy of it. Everything here is
 * computed from events, so dropping the index and rebuilding it from the log gives the same
 * memories. Nothing is deleted when she forgets; a memory only gets harder to reach on its own.
 */
export class MemoryIndex {
  private readonly traces = new Map<string, Trace>();
  /** Ids in the order they happened, for time-only questions. */
  private readonly order: string[] = [];
  private readonly postings = new Map<string, Map<string, number>>();
  /** Events that are not memories themselves but stand for one, e.g. an activity's end. */
  private readonly aliases = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private totalLength = 0;

  constructor(private readonly settings: MemorySettings) {}

  get size(): number {
    return this.traces.size;
  }

  add(event: LifeEvent): void {
    for (const id of usedBy(event)) {
      const trace = this.traces.get(this.resolve(id));
      if (trace) trace.uses.push(this.use(trace.uses, event.at));
    }
    if (event.kind === "felt") {
      // A feeling makes what it was about more memorable.
      const weight = Math.abs(event.payload.valence) * SALIENCE_PER_VALENCE;
      for (const cause of event.causes) {
        const trace = this.traces.get(this.resolve(cause));
        if (trace) trace.salience = Math.max(trace.salience, weight);
      }
    }
    if (event.kind === "heard" && event.payload.name) this.names.set(event.payload.personId, event.payload.name);
    const part = this.part(event);
    if (!part) {
      // An activity's end, a waking: remembering them means remembering what they belong to.
      const cause = event.causes.map((id) => this.resolve(id)).find((id) => this.traces.has(id));
      if (cause) this.aliases.set(event.id, cause);
      return;
    }
    const terms = tokenize(`${part.lead}${part.body}`);
    const personId =
      event.kind === "heard" || event.kind === "said" || event.kind === "noted" ? event.payload.personId : undefined;
    // A summary is about the time it sums up, not the night it was written.
    const summary = event.kind === "episode" || event.kind === "chapter" ? event.payload : undefined;
    const trace: Trace = {
      id: event.id,
      at: summary ? summary.from : event.at,
      kind: event.kind,
      ...(personId ? { personId } : {}),
      ...(summary ? { span: summary.to - summary.from } : {}),
      lead: part.lead,
      body: part.body,
      length: terms.length,
      uses: [this.use([], event.at)],
      salience: event.kind === "felt" ? Math.abs(event.payload.valence) * SALIENCE_PER_VALENCE : 0,
      links: [],
    };
    this.traces.set(event.id, trace);
    const last = this.traces.get(this.order.at(-1) ?? "");
    if (last && last.at > trace.at) this.order.splice(this.firstAtOrAfter(trace.at), 0, trace.id);
    else this.order.push(trace.id);
    this.totalLength += terms.length;
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, count] of counts) {
      let posting = this.postings.get(term);
      if (!posting) this.postings.set(term, (posting = new Map()));
      posting.set(event.id, count);
    }
    // A summary is tied to dozens of memories; it is reached by its words and its time instead.
    if (summary) return;
    for (const cause of event.causes) {
      const other = this.traces.get(this.resolve(cause));
      if (!other || other.id === trace.id) continue;
      other.links.push(trace.id);
      trace.links.push(other.id);
    }
  }
  /**
   * ACT-R base-level activation: ln Σ tᵢ^-dᵢ over every use, plus what makes it stick (strong
   * feelings, the kind of thing it was). Each use's decay dᵢ grows with how active the memory
   * already was then, so going over something again right away adds little and coming back to it
   * days later adds a lot: spaced uses outlast crammed ones.
   */
  strength(id: string, now: number): number | undefined {
    const trace = this.traces.get(this.resolve(id));
    if (!trace) return undefined;
    return this.activation(trace, now);
  }

  /**
   * What comes back from a cue. `deliberate` is her searching on purpose: anything that matches
   * is returned, best match first, and kinds she keeps records of are always clear. Otherwise
   * only memories alive enough to surface on their own come back, strongest first.
   */
  recall(cue: RecallCue, now: number, deliberate = false): Recollection[] {
    const parsed = cue.text ? parseWhen(cue.text, now, this.settings.timezone) : undefined;
    const range =
      cue.from !== undefined || cue.to !== undefined
        ? { from: cue.from ?? -Infinity, to: cue.to ?? now }
        : parsed?.range;
    const terms = [...new Set(tokenize(parsed?.rest ?? cue.text ?? ""))];
    // "我们聊了什么", "你答应过什么": asking about a conversation is a cue for conversations.
    const talk = TALK_WORDS.test(cue.text ?? "");
    const match = this.match(terms);
    this.spread(match);
    // A time word is a cue of its own: what happened then comes back even if no word matches.
    if (range) {
      for (const id of this.between(range.from, range.to)) if (!match.has(id)) match.set(id, 0);
    }
    const exclude = cue.exclude ?? new Set<string>();
    const scored: Array<{ trace: Trace; strength: number; match: number; score: number }> = [];
    for (const [id, value] of match) {
      const trace = this.traces.get(id);
      if (!trace || exclude.has(id) || trace.at > now) continue;
      const inRange = range ? trace.at >= range.from && trace.at < range.to : false;
      if (range && deliberate && !inRange) continue;
      const strength = this.activation(trace, now);
      const person = cue.personId && trace.personId === cue.personId ? PERSON_BONUS : 0;
      const time = inRange ? TIME_BONUS : 0;
      const kind =
        (talk && (trace.kind === "heard" || trace.kind === "said") ? TALK_BONUS : 0) + this.fit(trace, range, inRange);
      // Whether a memory surfaces depends on how alive it is plus the cue; which comes first
      // depends mostly on how well it fits what was asked.
      const activation = strength + value * MATCH_WEIGHT + person + time + kind;
      // On its own, a memory needs a word in common with the cue; a time word alone only helps.
      if (!deliberate && (value === 0 || activation < RETRIEVAL)) continue;
      const score = value * MATCH_WEIGHT + time + kind + person + strength * 0.25;
      scored.push({ trace, strength, match: value, score });
    }
    scored.sort((left, right) => right.score - left.score || right.trace.at - left.trace.at);
    return scored.slice(0, cue.limit ?? (deliberate ? 8 : 4)).map(({ trace, strength, match: value }) => {
      const clarity =
        deliberate && this.settings.records.has(trace.kind) ? "clear" : clarityOf(strength);
      return {
        id: trace.id,
        at: trace.at,
        kind: trace.kind,
        clarity,
        // Asked about a day, she knows which day it was even when the rest is hazy.
        text: this.render(trace, clarity, now, range !== undefined),
        strength: round(strength),
        match: round(value),
      };
    });
  }

  /**
   * Asked about a week, the week's chapter is the best answer; asked about a day, that day's
   * episodes. Asked by words, what was actually said comes before a summary that quotes it.
   */
  private fit(trace: Trace, range: { from: number; to: number } | undefined, inRange: boolean): number {
    if (trace.span === undefined) return 0;
    if (!range) return -SUMMARY_PENALTY;
    if (!inRange || !Number.isFinite(range.from)) return 0;
    const ratio = trace.span / Math.max(range.to - range.from, HOUR);
    return FIT_BONUS * Math.max(0, 1 - Math.abs(Math.log(ratio)) / Math.log(8));
  }

  private activation(trace: Trace, now: number): number {
    return baseLevel(trace.uses, now) + trace.salience + (KIND_WEIGHT[trace.kind] ?? 0);
  }

  /** `dᵢ = c·e^{mᵢ} + α`, where mᵢ is the activation just before this use. */
  private use(earlier: Use[], at: number): Use {
    const decay =
      earlier.length === 0
        ? this.settings.decay
        : SPACING * Math.exp(baseLevel(earlier, at)) + this.settings.decay * (1 - SPACING);
    return { at, decay: Math.min(MAX_DECAY, Math.max(MIN_DECAY, decay)) };
  }

  /** BM25 per memory, scaled so a memory holding every cue word once scores about 1. */
  private match(terms: string[]): Map<string, number> {
    const scores = new Map<string, number>();
    const count = this.traces.size;
    if (count === 0 || terms.length === 0) return scores;
    const average = this.totalLength / count || 1;
    let ideal = 0;
    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (count - posting.size + 0.5) / (posting.size + 0.5));
      ideal += idf;
      for (const [id, tf] of posting) {
        const length = this.traces.get(id)?.length ?? average;
        const weight = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * length) / average));
        scores.set(id, (scores.get(id) ?? 0) + idf * weight);
      }
    }
    if (ideal === 0) return scores;
    for (const [id, raw] of scores) scores.set(id, Math.min(1, raw / ideal));
    return scores;
  }

  /** Remembering one thing brings back a little of what it is tied to. */
  private spread(match: Map<string, number>): void {
    const spread = new Map<string, number>();
    for (const [id, value] of match) {
      const trace = this.traces.get(id);
      if (!trace || trace.links.length > SPREAD_MAX_LINKS || value === 0) continue;
      for (const link of trace.links) {
        spread.set(link, Math.max(spread.get(link) ?? 0, value * SPREAD));
      }
    }
    for (const [id, value] of spread) {
      if ((match.get(id) ?? -1) < value) match.set(id, value);
    }
  }

  private firstAtOrAfter(at: number): number {
    let low = 0;
    let high = this.order.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const trace = this.traces.get(this.order[middle]!);
      if (trace && trace.at < at) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private between(from: number, to: number): string[] {
    const found: string[] = [];
    for (let index = this.firstAtOrAfter(from); index < this.order.length; index++) {
      const trace = this.traces.get(this.order[index]!);
      if (!trace || trace.at >= to) break;
      found.push(trace.id);
    }
    return found;
  }

  private resolve(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  /** How one event is remembered: who or what it was about (`lead`), and what was in it. */
  private part(event: LifeEvent): { lead: string; body: string } | undefined {
    switch (event.kind) {
      case "born":
        return { lead: "你出生了", body: "" };
      case "heard":
        return { lead: `${event.payload.name ?? this.names.get(event.payload.personId) ?? "对方"}对你说：`, body: event.payload.text };
      case "said":
        return { lead: `你对${this.names.get(event.payload.personId) ?? "对方"}说：`, body: event.payload.text };
      case "wrote":
        return { lead: "你在笔记本上写了：", body: event.payload.text };
      case "reflected":
        return { lead: `你在 ${event.payload.day} 的日记里写：`, body: event.payload.diary };
      case "belief":
        return { lead: "你发现：", body: event.payload.statement };
      case "perceived":
        return { lead: "你注意到", body: event.payload.what };
      case "activity.started": {
        const material = event.payload.material;
        const body =
          material?.kind === "passage" ? `，读到「${material.text}」` : material?.kind === "view" ? `，看到${material.text}` : "";
        return { lead: event.payload.label, body };
      }
      case "felt":
        return { lead: "", body: event.payload.reason };
      case "noted": {
        const name = this.names.get(event.payload.personId) ?? "对方";
        const state = event.payload.done ? "（已办完）" : event.payload.pending ? "（还没办）" : "";
        return { lead: `你记下关于${name}的事（${event.payload.topic}）${state}：`, body: event.payload.text };
      }
      case "episode": {
        const time = localTime(event.payload.from, this.settings.timezone);
        return { lead: `${time.month}月${time.day}日${event.payload.part}：`, body: event.payload.summary };
      }
      case "chapter":
        return { lead: `${event.payload.label}：`, body: event.payload.summary };
      default:
        return undefined;
    }
  }

  private render(trace: Trace, clarity: Clarity, now: number, dated: boolean): string {
    const timezone = this.settings.timezone;
    // A summary already says when it was; how clearly she has it decides how much of it is left.
    if (trace.span !== undefined) {
      if (clarity === "clear") return `${trace.lead}${trace.body}`;
      return clarity === "vague" ? `${trace.lead}${clip(trace.body, 40)}` : `记不太清了，${trace.lead}${clip(trace.body, 15)}`;
    }
    if (clarity === "clear") return `${whenLabel(trace.at, now, timezone)} ${trace.lead}${trace.body}`;
    const rough = dated ? whenLabel(trace.at, now, timezone).split(" ")[0]! : roughly(trace.at, now, timezone);
    if (clarity === "vague") return `${rough}，${trace.lead}${clip(trace.body, 30)}`;
    return `记不太清了，好像是${rough}，${trace.lead}${clip(trace.body, 10)}`;
  }
}

function baseLevel(uses: Use[], now: number): number {
  let sum = 0;
  for (const use of uses) {
    if (use.at > now) break;
    sum += Math.max((now - use.at) / HOUR, MIN_AGE_HOURS) ** -use.decay;
  }
  return Math.log(Math.max(sum, Number.MIN_VALUE));
}

function clarityOf(strength: number): Clarity {
  return strength >= CLEAR ? "clear" : strength >= FAINT ? "vague" : "faint";
}

/** Earlier events an event makes use of: what speech and writing cite, what a belief rests on. */
function usedBy(event: LifeEvent): string[] {
  switch (event.kind) {
    case "said":
    case "wrote":
    case "reflected":
      return event.payload.grounds;
    case "belief":
      return event.payload.evidence;
    case "recalled":
      return event.payload.found;
    case "episode":
    case "chapter":
      return event.payload.kept;
    default:
      return [];
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

const SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });
const SINGLE_HAN = /^\p{Script=Han}$/u;
const STOPWORDS = new Set(
  (
    "的 了 着 过 吗 呢 吧 啊 呀 嘛 哦 噢 嗯 哈 么 是 在 有 和 与 跟 也 都 就 还 又 才 很 太 挺 " +
    "这 那 这个 那个 这些 那些 这里 那里 这样 那样 这么 那么 哪 哪个 哪里 什么 怎么 怎样 为什么 " +
    "我 你 他 她 它 我们 你们 他们 她们 自己 对 把 被 给 让 从 到 向 说 一 一个 一下 一点 " +
    "个 些 吗 啦 呗 而 或 但 但是 如果 因为 所以 然后 可以 可能 会 要 想 能 来 去 上 下 里 " +
    "来着 现在 刚才 之前 以后 时候 知道 记得 the a an and or of to is are was it"
  ).split(" "),
);

/**
 * The words a memory is found by. Built-in word segmentation, minus function words; runs of
 * single characters are also paired up, so a name the dictionary splits ("艾/拉") still matches.
 */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  let previous: string | undefined;
  for (const segment of SEGMENTER.segment(text.toLowerCase())) {
    if (!segment.isWordLike) {
      previous = undefined;
      continue;
    }
    const word = segment.segment;
    const stop = STOPWORDS.has(word);
    const single = SINGLE_HAN.test(word) && !stop;
    if (single && previous) terms.push(`${previous}${word}`);
    previous = single ? word : undefined;
    if (stop) continue;
    if (word.length === 1 && !single && !/\d/u.test(word)) continue;
    terms.push(word);
  }
  return terms;
}

const NUMBERS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 几: 3 };
const WEEKDAYS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

function number(text: string): number {
  return /^\d+$/u.test(text) ? Number(text) : (NUMBERS[text] ?? 1);
}

/**
 * Finds a time word in what was said and turns it into a span of time: 今天, 昨天, 前天,
 * 大前天, N 天前, 上周, 上周三, 周三, 这周, N 周前, 上个月, 这个月, N 个月前, M 月 D 日, 去年.
 * `rest` is the text with the time word taken out.
 */
export function parseWhen(
  text: string,
  now: number,
  timezone: string,
): { range: { from: number; to: number }; rest: string } | undefined {
  const today = dayStart(now, 0, timezone);
  const local = localTime(now, timezone);
  const isoWeekday = local.weekday === 0 ? 7 : local.weekday;
  const monday = dayStart(now, isoWeekday - 1, timezone);
  const day = (back: number) => ({ from: dayStart(now, back, timezone), to: dayStart(now, back - 1, timezone) });
  const patterns: Array<[RegExp, (match: RegExpExecArray) => { from: number; to: number } | undefined]> = [
    [/大前天/u, () => day(3)],
    [/前天/u, () => day(2)],
    [/昨天|昨晚|昨日/u, () => day(1)],
    [/今天|今早|今晚|今日/u, () => ({ from: today, to: now })],
    [/几天前/u, () => ({ from: dayStart(now, 6, timezone), to: dayStart(now, 1, timezone) })],
    [/(\d+|[一二两三四五六七八九十])天前/u, (m) => day(number(m[1]!))],
    [/上上(?:周|星期|礼拜)/u, () => ({ from: monday - 14 * DAY, to: monday - 7 * DAY })],
    [/上(?:周|星期|礼拜)([一二三四五六日天])/u, (m) => day(isoWeekday - 1 + 7 - ((WEEKDAYS[m[1]!] ?? 1) - 1))],
    [/上(?:个)?(?:周|星期|礼拜)/u, () => ({ from: monday - 7 * DAY, to: monday })],
    [/(?:这|本)(?:周|星期|礼拜)/u, () => ({ from: monday, to: now })],
    [/(\d+|[一二两三四五六七八九十几])(?:个)?(?:周|星期|礼拜)前/u, (m) => ({ from: monday - number(m[1]!) * 7 * DAY, to: monday - (number(m[1]!) - 1) * 7 * DAY })],
    [/上个?月/u, () => month(local.year, local.month - 1, timezone)],
    [/(?:这个|本)月/u, () => ({ from: month(local.year, local.month, timezone).from, to: now })],
    [/(\d+|[一二两三四五六七八九十几])个月前/u, (m) => month(local.year, local.month - number(m[1]!), timezone)],
    [/(\d{1,2})月(\d{1,2})[日号]/u, (m) => {
      const target = wallStart(local.year, Number(m[1]), Number(m[2]), timezone);
      const from = target > now ? wallStart(local.year - 1, Number(m[1]), Number(m[2]), timezone) : target;
      return { from, to: from + DAY };
    }],
    [/去年/u, () => ({ from: wallStart(local.year - 1, 1, 1, timezone), to: wallStart(local.year, 1, 1, timezone) })],
    // Not "下周五": that is ahead, and nothing has happened there yet.
    [/(?<![下这本])(?:周|星期|礼拜)([一二三四五六日天])/u, (m) => day((isoWeekday - (WEEKDAYS[m[1]!] ?? 1) + 7) % 7)],
  ];
  for (const [pattern, toRange] of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const range = toRange(match);
    if (!range) continue;
    return { range, rest: `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}` };
  }
  return undefined;
}

/** Local midnight `back` days before the day of `now`. */
function dayStart(now: number, back: number, timezone: string): number {
  const time = localTime(now, timezone);
  return wallStart(time.year, time.month, time.day - back, timezone);
}

const wallStart = localMidnight;

function month(year: number, month: number, timezone: string): { from: number; to: number } {
  return { from: wallStart(year, month, 1, timezone), to: wallStart(year, month + 1, 1, timezone) };
}

/** "今天", "三天前", "上个月": how long ago, the way one says it when unsure of the date. */
function roughly(at: number, now: number, timezone: string): string {
  const days = Math.round((dayStart(now, 0, timezone) - dayStart(at, 0, timezone)) / DAY);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days === 2) return "前天";
  if (days < 7) return "几天前";
  if (days < 14) return "一个多星期前";
  if (days < 30) return "几个星期前";
  if (days < 60) return "一个多月前";
  if (days < 365) return `${Math.round(days / 30)}个月前`;
  return days < 730 ? "一年多以前" : `${Math.floor(days / 365)}年前`;
}
