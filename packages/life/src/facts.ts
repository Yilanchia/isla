import { localTime } from "@isla/core";
import { clockLabel, DAY, localDayRange } from "./clock.js";
import type { LifeEvent } from "./events.js";
import type { MemoryIndex } from "./recall.js";
import type { Bond, LifeState } from "./state.js";

/**
 * One thing she can truthfully say about herself, with where it comes from.
 *
 * `id` is an event id (`e42`), a state reading (`state:energy`), or her origin
 * (`genome:origin`). A mind may only cite ids it was given; the kernel checks.
 *
 * `text` is the sentence for a person or a language model. The other fields carry the same
 * thing as data, so a mind that is code reads the fact instead of parsing the sentence. They are
 * optional only because a host may hand back facts it built itself; the kernel always sets them.
 */
export interface Fact {
  id: string;
  text: string;
  kind?: FactKind;
  /** The event the fact was read off, when there is one. */
  event?: LifeEvent;
  /** For facts about the past: whole local days before now, 0 being today. */
  daysAgo?: number;
  /** For state readings: the reading in plain words, without “你现在”, e.g. 精神还行. */
  words?: string;
}

export type FactKind =
  | "time"
  | "energy"
  | "mood"
  | "doing"
  | "need"
  | "origin"
  | "age"
  | "rhythm"
  | "shelf"
  | "bond"
  | "habit"
  | "self"
  | "note"
  | "event"
  | "chapter"
  | "recollection";

export function energyWords(energy: number): string {
  if (energy > 0.7) return "精神很好";
  if (energy > 0.45) return "精神还行";
  if (energy > 0.25) return "有点累了";
  return "很累了";
}

export function moodWords(valence: number): string {
  if (valence > 0.25) return "心情很好";
  if (valence > 0.08) return "心情不错";
  if (valence > -0.05) return "心情平平";
  if (valence > -0.2) return "心情有点低落";
  return "心情很低落";
}

/** Whole local days between `at` and `now`: 0 today, 1 yesterday. */
export function daysAgo(at: number, now: number, timezone: string): number {
  const then = localTime(at, timezone);
  const today = localTime(now, timezone);
  const thenDay = Date.UTC(then.year, then.month - 1, then.day);
  const todayDay = Date.UTC(today.year, today.month - 1, today.day);
  return Math.round((todayDay - thenDay) / DAY);
}

/** "今天 14:30", "昨天 09:05", or a date for anything older. */
export function whenLabel(at: number, now: number, timezone: string): string {
  const days = daysAgo(at, now, timezone);
  const then = localTime(at, timezone);
  const prefix =
    days === 0 ? "今天" : days === 1 ? "昨天" : days === 2 ? "前天" : `${then.month}月${then.day}日`;
  return `${prefix} ${clockLabel(at, timezone)}`;
}

/** Event ids are `e<seq>` and the log starts at seq 1, so the lookup is usually direct. */
function eventById(events: LifeEvent[], id: string): LifeEvent | undefined {
  const direct = events[Number(id.slice(1)) - 1];
  if (direct?.id === id) return direct;
  return findLast(events, (event) => event.id === id);
}

function quote(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The sentence a single event contributes to her account of herself, if any. */
export function describeEvent(event: LifeEvent, now: number, timezone: string): string | undefined {
  const when = whenLabel(event.at, now, timezone);
  switch (event.kind) {
    case "woke":
      return event.payload.by ? `${when} ${event.payload.reason}` : `${when} 醒来`;
    case "slept":
      return `${when} 睡下`;
    case "perceived":
      return `${when} 注意到${event.payload.what}`;
    case "activity.started": {
      const material = event.payload.material;
      const extra =
        material?.kind === "passage"
          ? `，读到「${quote(material.text)}」`
          : material?.kind === "view"
            ? `，看到${material.text}`
            : material?.kind === "item"
              ? `：「${material.title}」${material.text ? `——${quote(material.text, 60)}` : ""}`
              : "";
      return `${when} 开始${event.payload.label}${extra}`;
    }
    case "activity.ended":
      return event.payload.interrupted ? `${when} 没做完就停下了${event.payload.label}` : undefined;
    case "felt":
      return `${when} ${event.payload.reason}`;
    case "wrote":
      return `${when} 在笔记本上写了：${quote(event.payload.text, 60)}`;
    case "reflected":
      return `${when} 写日记：${event.payload.diary}`;
    case "belief":
      return `${when} 发现：${event.payload.statement}`;
    case "heard":
      return `${when} ${event.payload.name ?? "对方"}对你说：${quote(event.payload.text, 60)}`;
    case "said":
      return `${when} 你回答：${quote(event.payload.text, 60)}`;
    case "urged":
      return `${when} 你想主动找人说话：${event.payload.about}`;
    case "bonded":
      return `${when} 你觉得和对方更${BOND_WORDS[event.payload.bond]}了：${event.payload.because}`;
    case "noted":
      return `${when} 你记下（${event.payload.topic}）：${quote(event.payload.text, 60)}${event.payload.done ? "，已经办完" : ""}`;
    case "lapsed":
      return `${whenLabel(event.payload.from, now, timezone)} 到 ${whenLabel(event.payload.to, now, timezone)} 之间你没有醒着，什么也不记得`;
    default:
      return undefined;
  }
}

export const BOND_WORDS: Record<Bond, string> = { stranger: "初识", familiar: "熟悉", close: "亲近", trusted: "信赖" };

const PARTS: Array<[string, number[]]> = [
  ["早上", [6, 7, 8]],
  ["上午", [9, 10, 11]],
  ["中午", [12, 13]],
  ["下午", [14, 15, 16, 17]],
  ["晚上", [18, 19, 20, 21, 22]],
  ["深夜", [23, 0, 1, 2, 3, 4, 5]],
];

/** When they usually come, once there is enough to say: the parts of the day with most of it. */
function usualHours(hours: readonly number[] | undefined): string | undefined {
  if (!hours) return undefined;
  const total = hours.reduce((sum, count) => sum + count, 0);
  if (total < 20) return undefined;
  const parts = PARTS.map(([label, slots]) => ({ label, share: slots.reduce((sum, hour) => sum + (hours[hour] ?? 0), 0) / total }))
    .filter((part) => part.share >= 0.25)
    .sort((left, right) => right.share - left.share)
    .slice(0, 2);
  return parts.length > 0 ? `在${parts.map((part) => part.label).join("和")}` : undefined;
}

function findLast<T>(items: readonly T[], test: (item: T) => boolean, within = Infinity): T | undefined {
  for (let index = items.length - 1; index >= Math.max(0, items.length - within); index--) {
    if (test(items[index]!)) return items[index];
  }
  return undefined;
}

export interface GatherOptions {
  now: number;
  /** How far back events are offered. Default 36 hours. */
  lookbackMs?: number;
  /** A local date (`YYYY-MM-DD`) to draw events from instead of the lookback window. */
  focusDay?: string;
  /** Conversation partner, so the recent exchange with them is included. */
  personId?: string;
  limit?: number;
  /** Her memory. With a `cue`, older things the cue brings to mind are included. */
  memory?: MemoryIndex;
  /** Usually what was just said to her. */
  cue?: string;
  /** How many memories a cue may bring back. Default 4. */
  recallLimit?: number;
  /** How many notes about the person are always in front of her. Default 12. */
  notesLimit?: number;
  /** How she names each shelf, e.g. `{ news: "看新闻" }`. */
  shelfLabels?: Record<string, string>;
  /** Memories close in meaning to the cue, from the host's semantic search. See `RecallCue.similar`. */
  similar?: ReadonlyMap<string, number>;
}

/**
 * The facts a mind is given before it speaks: how she is right now, what she believes about
 * herself, her last diary, and what happened recently. Nothing here is invented; each line is
 * read off the state or one event.
 */
export function gatherFacts(state: LifeState, events: LifeEvent[], options: GatherOptions): Fact[] {
  const timezone = state.genome.timezone;
  const now = options.now;
  const facts: Fact[] = [];
  const time = localTime(now, timezone);
  facts.push({ id: "state:time", kind: "time", text: `现在是${time.partOfDay} ${clockLabel(now, timezone)}` });
  const energy = energyWords(state.energy);
  facts.push({ id: "state:energy", kind: "energy", words: energy, text: `你现在${energy}` });
  const mood = moodWords(state.mood.valence);
  facts.push({ id: "state:mood", kind: "mood", words: mood, text: `你现在${mood}` });
  if (state.activity) {
    // Activity labels already read "在窗边看外面"; do not stack another 正在在.
    const doing = state.activity.label.replace(/^在/u, "");
    const started = eventById(events, state.activity.startedId);
    facts.push({
      id: state.activity.startedId,
      kind: "doing",
      words: doing,
      text: `你此刻正在${doing}`,
      ...(started ? { event: started } : {}),
    });
  }
  const needs: Array<[string, string]> = [];
  if (state.drives.connection > 0.7) needs.push(["connection", "你很想有人陪你说说话"]);
  if (state.drives.curiosity > 0.7) needs.push(["curiosity", "你很想看点新东西"]);
  if (state.drives.expression > 0.7) needs.push(["expression", "你心里有话想写下来"]);
  for (const [drive, text] of needs) facts.push({ id: `state:${drive}`, kind: "need", words: drive, text });
  if (state.genome.origin) {
    facts.push({ id: "genome:origin", kind: "origin", words: state.genome.origin, text: `你的来历：${state.genome.origin}` });
  }
  const days = Math.max(0, Math.floor((now - state.bornAt) / DAY));
  facts.push({
    id: "state:age",
    kind: "age",
    words: days === 0 ? "今天才出生" : `出生到现在 ${days} 天了`,
    text: days === 0 ? "你今天才出生" : `你出生到现在 ${days} 天了`,
  });
  // Looking back on one day, a belief counts as something she found out that day, not as a
  // standing fact; it is picked up below with the rest of the day's events.
  if (!options.focusDay) {
    for (const belief of Object.values(state.beliefs)) {
      const event = eventById(events, belief.eventId);
      facts.push({
        id: belief.eventId,
        kind: "self",
        words: belief.statement,
        text: `你对自己的认识：${belief.statement}`,
        ...(event ? { event } : {}),
      });
    }
  }
  // The log is in time order, so every lookup below walks back from the end and stops early.
  const { wakeHour, sleepHour } = state.genome.chronotype;
  facts.push({
    id: "state:rhythm",
    kind: "rhythm",
    text: `你每天 ${sleepHour}:00 左右睡下，${wakeHour}:00 左右醒来；睡着的时候有人叫你，你会醒`,
  });
  // What is waiting on her shelves, newest first, so she can bring it up instead of looking it up.
  if (!options.focusDay) {
    for (const [shelf, items] of Object.entries(state.shelves)) {
      if (items.length === 0) continue;
      const titles = items.slice(-3).reverse().map((item) => `「${quote(item.title, 30)}」（${item.source}）`);
      const label = options.shelfLabels?.[shelf] ?? shelf;
      facts.push({
        id: `state:shelf:${shelf}`,
        kind: "shelf",
        words: shelf,
        text: `${label}：还有 ${items.length} 样没看，最新的是${titles.join("、")}`,
      });
    }
  }
  // How well she knows the person in front of her, and what she has noticed about their habits.
  const person = options.personId ? state.people[options.personId] : undefined;
  if (person && !options.focusDay) {
    const name = person.name ?? "对方";
    const known = Math.floor((now - person.firstHeardAt) / DAY);
    facts.push({
      id: `state:bond:${person.personId}`,
      kind: "bond",
      words: BOND_WORDS[person.bond],
      text: `你和${name}：${BOND_WORDS[person.bond]}（认识 ${known} 天，聊过 ${person.talkDays} 天、${person.exchanges} 句）`,
    });
    const usual = usualHours(person.hours);
    if (usual) {
      facts.push({ id: `state:habit:${person.personId}`, kind: "habit", words: usual, text: `${name}通常${usual}来找你` });
    }
  }
  // What she keeps about the person in front of her: what is still to be done first, then facts.
  if (options.personId && !options.focusDay) {
    const name = state.people[options.personId]?.name ?? "对方";
    const notes = Object.values(state.notes[options.personId] ?? {}).sort((left, right) =>
      left.pending === right.pending ? right.at - left.at : left.pending ? -1 : 1,
    );
    for (const note of notes.slice(0, options.notesLimit ?? 12)) {
      const event = eventById(events, note.eventId);
      facts.push({
        id: note.eventId,
        kind: "note",
        words: note.text,
        text: note.pending ? `还没办完的事（${name}）：${note.text}` : `你记下的关于${name}的事（${note.topic}）：${note.text}`,
        ...(event ? { event } : {}),
      });
    }
  }
  const diary = findLast(events, (event) => event.kind === "reflected");
  const used = new Set(facts.map((fact) => fact.id));
  const pushEvent = (event: LifeEvent): void => {
    if (used.has(event.id)) return;
    const text = describeEvent(event, now, timezone);
    if (!text) return;
    used.add(event.id);
    facts.push({ id: event.id, kind: "event", event, daysAgo: daysAgo(event.at, now, timezone), text });
  };
  if (diary) pushEvent(diary);
  // Further back than her diary, she has the last week and the last month as one line each.
  if (!options.focusDay) {
    for (const span of ["week", "month"] as const) {
      // A chapter older than about two months of events is not "the last" one any more.
      const chapter = findLast(events, (event) => event.kind === "chapter" && event.payload.span === span, 6000);
      if (chapter?.kind !== "chapter" || used.has(chapter.id)) continue;
      used.add(chapter.id);
      const summary = chapter.payload.summary;
      facts.push({
        id: chapter.id,
        kind: "chapter",
        event: chapter,
        daysAgo: daysAgo(chapter.at, now, timezone),
        text: `${span === "week" ? "最近一周" : "最近一个月"}（${chapter.payload.label}）：${summary.length > 120 ? `${summary.slice(0, 120)}…` : summary}`,
      });
    }
  }
  if (options.personId) {
    const exchange: LifeEvent[] = [];
    for (let index = events.length - 1; index >= 0 && exchange.length < 8; index--) {
      const event = events[index]!;
      if ((event.kind === "heard" || event.kind === "said") && event.payload.personId === options.personId) {
        exchange.push(event);
      }
    }
    exchange.reverse().forEach(pushEvent);
  }
  const limit = options.limit ?? 48;
  const window = options.focusDay
    ? localDayRange(options.focusDay, timezone)
    : { from: now - (options.lookbackMs ?? 1.5 * DAY), to: Infinity };
  const recent: LifeEvent[] = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.at < window.from) break;
    // Talk normally comes in through the exchange above; looking back on a day, it is part of it.
    const talk = event.kind === "heard" || event.kind === "said";
    if (event.at < window.to && (options.focusDay || !talk)) recent.push(event);
  }
  recent.reverse();
  // Keep the newest events that fit, but list them in the order they happened.
  const described = recent.filter((event) => !used.has(event.id) && describeEvent(event, now, timezone));
  const reserve = options.memory && options.cue ? (options.recallLimit ?? 4) : 0;
  const room = Math.max(0, limit - facts.length - reserve);
  const shown = described.slice(Math.max(0, described.length - room));
  const recollections =
    reserve > 0 && options.memory && options.cue
      ? options.memory.recall(
          {
            text: options.cue,
            ...(options.personId ? { personId: options.personId } : {}),
            limit: reserve,
            exclude: new Set([...used, ...shown.map((event) => event.id)]),
            ...(options.similar ? { similar: options.similar } : {}),
          },
          now,
        )
      : [];
  shown.forEach(pushEvent);
  for (const recollection of recollections.sort((left, right) => left.at - right.at)) {
    if (used.has(recollection.id)) continue;
    used.add(recollection.id);
    const event = eventById(events, recollection.id);
    facts.push({
      id: recollection.id,
      kind: "recollection",
      text: `你想起：${recollection.text}`,
      daysAgo: daysAgo(recollection.at, now, timezone),
      ...(event ? { event } : {}),
    });
  }
  return facts;
}
