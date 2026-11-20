import type { ActivityKind } from "./activities.js";
import type { LifeState } from "./state.js";
import type { Fact } from "./facts.js";
import type {
  DriveLevels,
  Grounding,
  LifeEvent,
  LifeEventKind,
  LifeEventPayloads,
  Material,
} from "./events.js";
import type { InnerMind, Mind } from "./mind.js";
import type { MemoryIndex } from "./recall.js";
import type { World } from "./world.js";

/**
 * What the modules outside `life.ts` are allowed to touch on a running life. It is deliberately
 * narrow: the log, the folded state, the emit/commit pair and the serial queue. Anything that
 * could create an event from thin air stays in `Life`.
 *
 * @internal
 */
export interface LifeInternals {
  current: LifeState;
  log: LifeEvent[];
  readonly archive: { append(events: LifeEvent[]): Promise<void> };
  readonly world: World;
  readonly kinds: Map<string, ActivityKind>;
  mind: Mind;
  readonly inner: InnerMind;
  readonly mindCallsPerDay: number;
  readonly crisisReply: string;
  readonly reachOut: { personIds: string[] } | undefined;
  readonly logger: { warn(message: string, error?: unknown): void };
  readonly clock: () => number;
  readonly memory: MemoryIndex;
  readonly maxCatchUpMs: number;
  cursor: number;

  catchUp(now: number): Promise<void>;
  live(target: number): Promise<void>;

  emit<K extends LifeEventKind>(
    at: number,
    draft: { kind: K; payload: LifeEventPayloads[K]; causes?: string[] },
  ): Promise<LifeEvent<K>>;
  commit(at: number, drafts: Draft[]): Promise<LifeEvent[]>;
  serial<T>(work: () => Promise<T>): Promise<T>;
}

export type Draft = {
  [K in LifeEventKind]: { kind: K; payload: LifeEventPayloads[K]; causes?: string[] };
}[LifeEventKind];

/** Keeps the ids that were offered and records the ones that were not. */
export function checkGrounds(offered: Fact[], cited: string[]): Grounding {
  const texts = new Map(offered.map((fact) => [fact.id, fact.text]));
  const unique = [...new Set(cited)];
  const grounds = unique.filter((id) => texts.has(id));
  const rejected = unique.filter((id) => !texts.has(id));
  const facts = Object.fromEntries(grounds.map((id) => [id, texts.get(id) ?? ""]));
  return { grounds, rejected, facts };
}

export function lastHeardAt(state: LifeState): number {
  return Math.max(-Infinity, ...Object.values(state.people).map((person) => person.lastHeardAt));
}

export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function findLast<T>(items: readonly T[], test: (item: T) => boolean, within = Infinity): T | undefined {
  for (let index = items.length - 1; index >= Math.max(0, items.length - within); index--) {
    if (test(items[index]!)) return items[index];
  }
  return undefined;
}

export function isEventId(id: string): boolean {
  return /^e\d+$/u.test(id);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown error";
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function roundDrives(drives: DriveLevels): DriveLevels {
  return {
    curiosity: round(drives.curiosity),
    expression: round(drives.expression),
    connection: round(drives.connection),
  };
}

export function seqOf(id: string): number {
  return Number(id.slice(1));
}

const HOUR = 60 * 60 * 1000;

export function nextTopOfHour(after: number): number {
  return (Math.floor(after / HOUR) + 1) * HOUR;
}

export type MaterialRef = Material;
