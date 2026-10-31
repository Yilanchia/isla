import { localTime } from "@isla/core";
import { clockLabel, DAY } from "./clock.js";
import type { LifeEvent } from "./events.js";
import { dayKey, type LifeState } from "./state.js";

/**
 * One thing she can truthfully say about herself, with where it comes from.
 *
 * `id` is an event id (`e42`), a state reading (`state:energy`), or her origin
 * (`genome:origin`). A mind may only cite ids it was given; the kernel checks.
 */
export interface Fact {
  id: string;
  text: string;
}

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

/** "今天 14:30", "昨天 09:05", or a date for anything older. */
export function whenLabel(at: number, now: number, timezone: string): string {
  const then = localTime(at, timezone);
  const today = localTime(now, timezone);
  const thenDay = Date.UTC(then.year, then.month - 1, then.day);
  const todayDay = Date.UTC(today.year, today.month - 1, today.day);
  const days = Math.round((todayDay - thenDay) / DAY);
  const prefix =
    days === 0 ? "今天" : days === 1 ? "昨天" : days === 2 ? "前天" : `${then.month}月${then.day}日`;
  return `${prefix} ${clockLabel(at, timezone)}`;
}

function quote(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The sentence a single event contributes to her account of herself, if any. */
export function describeEvent(event: LifeEvent, now: number, timezone: string): string | undefined {
  const when = whenLabel(event.at, now, timezone);
  switch (event.kind) {
    case "woke":
      return `${when} 醒来`;
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
    case "lapsed":
      return `${whenLabel(event.payload.from, now, timezone)} 到 ${whenLabel(event.payload.to, now, timezone)} 之间你没有醒着，什么也不记得`;
    default:
      return undefined;
  }
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
  facts.push({ id: "state:time", text: `现在是${time.partOfDay} ${clockLabel(now, timezone)}` });
  facts.push({ id: "state:energy", text: `你现在${energyWords(state.energy)}` });
  facts.push({ id: "state:mood", text: `你现在${moodWords(state.mood.valence)}` });
  if (state.activity) {
    facts.push({ id: state.activity.startedId, text: `你此刻正在${state.activity.label}` });
  }
  if (state.drives.connection > 0.7) facts.push({ id: "state:connection", text: "你很想有人陪你说说话" });
  if (state.drives.curiosity > 0.7) facts.push({ id: "state:curiosity", text: "你很想看点新东西" });
  if (state.drives.expression > 0.7) facts.push({ id: "state:expression", text: "你心里有话想写下来" });
  if (state.genome.origin) facts.push({ id: "genome:origin", text: `你的来历：${state.genome.origin}` });
  const days = Math.max(0, Math.floor((now - state.bornAt) / DAY));
  facts.push({ id: "state:age", text: days === 0 ? "你今天才出生" : `你出生到现在 ${days} 天了` });
  // Looking back on one day, a belief counts as something she found out that day, not as a
  // standing fact; it is picked up below with the rest of the day's events.
  if (!options.focusDay) {
    for (const belief of Object.values(state.beliefs)) {
      facts.push({ id: belief.eventId, text: `你对自己的认识：${belief.statement}` });
    }
  }
  const diary = [...events].reverse().find((event) => event.kind === "reflected");
  const used = new Set(facts.map((fact) => fact.id));
  const pushEvent = (event: LifeEvent): void => {
    if (used.has(event.id)) return;
    const text = describeEvent(event, now, timezone);
    if (!text) return;
    used.add(event.id);
    facts.push({ id: event.id, text });
  };
  if (diary) pushEvent(diary);
  if (options.personId) {
    const exchange = events
      .filter(
        (event) =>
          (event.kind === "heard" || event.kind === "said") &&
          event.payload.personId === options.personId,
      )
      .slice(-8);
    exchange.forEach(pushEvent);
  }
  const since = now - (options.lookbackMs ?? 1.5 * DAY);
  const limit = options.limit ?? 48;
  const inWindow = (event: LifeEvent): boolean =>
    options.focusDay ? dayKey(event.at, timezone) === options.focusDay : event.at >= since;
  const recent = events.filter(
    (event) => inWindow(event) && event.kind !== "heard" && event.kind !== "said",
  );
  // Keep the newest events that fit, but list them in the order they happened.
  const described = recent.filter((event) => !used.has(event.id) && describeEvent(event, now, timezone));
  const room = Math.max(0, limit - facts.length);
  described.slice(Math.max(0, described.length - room)).forEach(pushEvent);
  return facts;
}
