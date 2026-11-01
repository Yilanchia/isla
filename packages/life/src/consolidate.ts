import { localTime } from "@isla/core";
import { DAY, localDayRange, localMidnight } from "./clock.js";
import type { LifeEvent, LifeEventPayloads } from "./events.js";

/**
 * What she does with a day while she sleeps: each stretch of it becomes one memory (an episode),
 * and at the end of a week or a month the episodes become a chapter. The kernel writes them from
 * the events alone, so they cost nothing and say nothing the events do not; each summary records
 * which events it mentions, and going over those in sleep strengthens them.
 */

type Draft<K extends "episode" | "chapter"> = { kind: K; payload: LifeEventPayloads[K]; causes: string[] };

export interface ConsolidationContext {
  timezone: string;
  /** How well each memory is held right now; the best-held lines are the ones summed up. */
  strength: (id: string) => number;
  names: (personId: string) => string;
}

const MEMORABLE = new Set<LifeEvent["kind"]>(["heard", "said", "activity.started", "wrote", "belief", "felt", "perceived"]);

/** 上午 06–12, 下午 12–18, 晚上 18–24, 夜里 00–06. */
export function partOfDay(at: number, timezone: string): string {
  const hour = localTime(at, timezone).hour;
  return hour < 6 ? "夜里" : hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** A few short clauses for a stretch of events, and the ids of the events they mention. */
function summarize(events: LifeEvent[], lines: number, context: ConsolidationContext): { summary: string; kept: string[] } {
  const parts: string[] = [];
  const kept: string[] = [];
  const byStrength = (left: LifeEvent, right: LifeEvent) => context.strength(right.id) - context.strength(left.id);

  const reading = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "activity.started" || event.payload.activity === "rest") continue;
    const label = event.payload.label.replace(/^重读/u, "读");
    if (!reading.has(label)) reading.set(label, event.id);
  }
  if (reading.size > 0) {
    parts.push([...reading.keys()].slice(0, 4).join("、"));
    kept.push(...[...reading.values()].slice(0, 4));
  }

  const talks = new Map<string, LifeEvent<"heard">[]>();
  for (const event of events) {
    if (event.kind !== "heard") continue;
    talks.set(event.payload.personId, [...(talks.get(event.payload.personId) ?? []), event]);
  }
  for (const [personId, heard] of talks) {
    const best = [...heard].sort(byStrength).slice(0, lines);
    const quotes = best.map((event) => `「${clip(event.payload.text, 20)}」`).join("");
    parts.push(`和${context.names(personId)}说了 ${heard.length} 次话，说到${quotes}`);
    kept.push(...best.map((event) => event.id));
  }

  const beliefs = events.filter((event): event is LifeEvent<"belief"> => event.kind === "belief");
  if (beliefs.length > 0) {
    const shown = beliefs.slice(-lines);
    parts.push(`发现${shown.map((event) => event.payload.statement.replace(/^我/u, "")).join("，")}`);
    kept.push(...shown.map((event) => event.id));
  }

  const felt = events
    .filter((event): event is LifeEvent<"felt"> => event.kind === "felt" && Math.abs(event.payload.valence) >= 0.1)
    .sort((left, right) => Math.abs(right.payload.valence) - Math.abs(left.payload.valence))[0];
  if (felt) {
    parts.push(felt.payload.reason);
    kept.push(felt.id);
  }

  const notes = events.filter((event) => event.kind === "wrote").length;
  if (notes > 0) parts.push(notes === 1 ? "写了一条笔记" : `写了 ${notes} 条笔记`);

  return { summary: parts.join("；"), kept: [...new Set(kept)] };
}

/** The day's stretches, from `from` up to `to`, one episode each. Empty stretches are skipped. */
export function episodesOf(
  log: readonly LifeEvent[],
  day: string,
  from: number,
  to: number,
  context: ConsolidationContext,
): Draft<"episode">[] {
  const events: LifeEvent[] = [];
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]!;
    if (event.at < from) break;
    if (event.at < to && MEMORABLE.has(event.kind)) events.push(event);
  }
  events.reverse();
  const stretches: Array<{ part: string; events: LifeEvent[] }> = [];
  for (const event of events) {
    const part = partOfDay(event.at, context.timezone);
    const last = stretches.at(-1);
    if (last?.part === part) last.events.push(event);
    else stretches.push({ part, events: [event] });
  }
  const drafts: Draft<"episode">[] = [];
  stretches.forEach((stretch, index) => {
    const { summary, kept } = summarize(stretch.events, 1, context);
    if (!summary) return;
    const start = index === 0 ? from : stretch.events[0]!.at;
    const end = stretches[index + 1]?.events[0]?.at ?? to;
    drafts.push({
      kind: "episode",
      causes: kept,
      payload: { day, part: stretch.part, from: start, to: end, summary, covers: stretch.events.map((event) => event.id), kept },
    });
  });
  return drafts;
}

/** The chapters that close with `day`: its week if it is a Sunday, its month if it is the last day. */
export function chaptersOf(log: readonly LifeEvent[], day: string, context: ConsolidationContext): Draft<"chapter">[] {
  const { from: dayFrom } = localDayRange(day, context.timezone);
  const time = localTime(dayFrom, context.timezone);
  const spans: Array<{ span: "week" | "month"; from: number; to: number; label: string }> = [];
  if (time.weekday === 0) {
    const from = localMidnight(time.year, time.month, time.day - 6, context.timezone);
    const to = localMidnight(time.year, time.month, time.day + 1, context.timezone);
    const first = localTime(from, context.timezone);
    spans.push({ span: "week", from, to, label: `${first.month}月${first.day}日到${time.month}月${time.day}日` });
  }
  if (localTime(dayFrom + DAY + 2 * 60 * 60 * 1000, context.timezone).month !== time.month) {
    const from = localMidnight(time.year, time.month, 1, context.timezone);
    const to = localMidnight(time.year, time.month + 1, 1, context.timezone);
    spans.push({ span: "month", from, to, label: `${time.year}年${time.month}月` });
  }
  const drafts: Draft<"chapter">[] = [];
  for (const span of spans) {
    const events: LifeEvent[] = [];
    const episodes: string[] = [];
    for (let index = log.length - 1; index >= 0; index--) {
      const event = log[index]!;
      if (event.at < span.from) break;
      if (event.kind === "episode" && event.payload.from >= span.from && event.payload.from < span.to) {
        episodes.push(event.id);
      } else if (event.at < span.to && MEMORABLE.has(event.kind)) {
        events.push(event);
      }
    }
    if (episodes.length === 0) continue;
    events.reverse();
    const { summary, kept } = summarize(events, 3, context);
    if (!summary) continue;
    drafts.push({
      kind: "chapter",
      causes: kept,
      payload: { span: span.span, label: span.label, from: span.from, to: span.to, summary, covers: episodes.reverse(), kept },
    });
  }
  return drafts;
}
