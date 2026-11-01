import { localTime } from "@isla/core";
import {
  DRIVES,
  FREE_MINDS,
  SAFETY_MIND_NAME,
  type Drive,
  type DriveLevels,
  type LifeEvent,
  type Material,
} from "./events.js";
import type { Genome } from "./genome.js";

const HOUR = 60 * 60 * 1000;

/** How fast each drive grows per waking hour, before temperament. */
export const DRIVE_GROWTH_PER_HOUR: DriveLevels = {
  curiosity: 0.12,
  expression: 0.07,
  connection: 0.05,
};

/** Energy spent per waking hour when she is not doing anything in particular. */
export const IDLE_COST_PER_HOUR = 0.04;
/** Energy recovered per hour of sleep. */
export const SLEEP_RECOVERY_PER_HOUR = 0.11;

const MOOD_HALF_LIFE_MS = 3 * HOUR;
const AROUSAL_HALF_LIFE_MS = 1.5 * HOUR;

export interface CurrentActivity {
  startedId: string;
  activity: string;
  label: string;
  motive: Drive | "none";
  startedAt: number;
  endsAt: number;
  costPerHour: number;
  satisfies: Partial<DriveLevels>;
  material?: Material;
}

export interface Taste {
  sum: number;
  count: number;
  /** Felt events that formed this taste, newest last. */
  evidence: string[];
}

export interface Belief {
  key: string;
  stance: "like" | "dislike" | "unsure";
  statement: string;
  evidence: string[];
  confidence: number;
  eventId: string;
  at: number;
}

/** The current note on one topic about one person. */
export interface Note {
  eventId: string;
  topic: string;
  text: string;
  at: number;
  source: string;
  pending: boolean;
}

export interface Acquaintance {
  personId: string;
  name?: string;
  firstHeardAt: number;
  lastHeardAt: number;
  exchanges: number;
}

/**
 * Everything she is right now, computed from the log and nothing else. It is a cache: delete it
 * and `replay()` rebuilds it, bit for bit.
 */
export interface LifeState {
  lifeId: string;
  genome: Genome;
  bornAt: number;
  /** Time of the last event folded in. */
  at: number;
  seq: number;
  mind: string;
  asleep: boolean;
  /** When the current waking or sleeping period began, and what began it. */
  since: number;
  sinceId: string;
  /** `called`: someone woke her up, as opposed to waking on her own. */
  sinceKind: "born" | "woke" | "called" | "slept" | "lapsed";
  energy: number;
  drives: DriveLevels;
  mood: { valence: number; arousal: number };
  activity?: CurrentActivity;
  /** The last activity she started and the last one she finished, for habit and causality. */
  lastActivity?: string;
  lastEndedId?: string;
  tastes: Record<string, Taste>;
  beliefs: Record<string, Belief>;
  /** Next passage index per book. */
  reading: Record<string, number>;
  people: Record<string, Acquaintance>;
  /** What she keeps about each person, by topic: the latest note wins. */
  notes: Record<string, Record<string, Note>>;
  /** Messages heard while asleep, waiting for her to wake up. */
  pending: Array<{ id: string; personId: string }>;
  weather?: string;
  /** Last time each feeling tag was felt, so the kernel does not repeat it all day. */
  tags: Record<string, number>;
  mindDay: string;
  mindCallsToday: number;
}

export function dayKey(at: number, timezone: string): string {
  const time = localTime(at, timezone);
  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Lets time pass with nothing happening: drives grow while she is awake, energy drains (or
 * recovers in sleep), and feelings fade back to her temperament. Between two events the
 * activity is fixed, so this has a closed form and splitting an interval changes nothing.
 */
export function advance(state: LifeState, to: number): LifeState {
  const elapsed = Math.max(0, to - state.at);
  if (elapsed === 0) return state;
  const hours = elapsed / HOUR;
  const temperament = state.genome.temperament;
  const next: LifeState = { ...state, at: to, drives: { ...state.drives }, mood: { ...state.mood } };
  if (!state.asleep) {
    const growth: DriveLevels = {
      curiosity: DRIVE_GROWTH_PER_HOUR.curiosity * temperament.curiosity,
      expression: DRIVE_GROWTH_PER_HOUR.expression * temperament.expression,
      connection: DRIVE_GROWTH_PER_HOUR.connection * temperament.sociability,
    };
    for (const drive of DRIVES) {
      next.drives[drive] = clamp(next.drives[drive] + growth[drive] * hours);
    }
    const cost = state.activity?.costPerHour ?? IDLE_COST_PER_HOUR;
    next.energy = clamp(state.energy - cost * hours);
  } else {
    next.energy = clamp(state.energy + SLEEP_RECOVERY_PER_HOUR * hours);
  }
  const moodDecay = Math.exp((-Math.LN2 * elapsed) / MOOD_HALF_LIFE_MS);
  const arousalDecay = Math.exp((-Math.LN2 * elapsed) / AROUSAL_HALF_LIFE_MS);
  const baseline = temperament.baselineValence;
  next.mood.valence = baseline + (state.mood.valence - baseline) * moodDecay;
  next.mood.arousal = state.mood.arousal * arousalDecay;
  return next;
}

/** Applies one event to a state that has already been advanced to the event's time. */
function apply(state: LifeState, event: LifeEvent): LifeState {
  const next: LifeState = { ...state, seq: event.seq, at: event.at };
  const timezone = state.genome.timezone;
  switch (event.kind) {
    case "born":
      return next;
    case "woke": {
      const by = event.payload.by;
      if (!by) return { ...next, asleep: false, since: event.at, sinceId: event.id, sinceKind: "woke" };
      // She was woken for this message, so it no longer waits for her to wake on her own.
      return {
        ...next,
        asleep: false,
        since: event.at,
        sinceId: event.id,
        sinceKind: "called",
        pending: state.pending.filter((item) => item.id !== by),
      };
    }
    case "slept": {
      const { activity: _activity, ...rest } = next;
      return { ...rest, asleep: true, since: event.at, sinceId: event.id, sinceKind: "slept" };
    }
    case "perceived":
      return event.payload.source === "weather"
        ? { ...next, weather: event.payload.detail ?? event.payload.what }
        : next;
    case "activity.started": {
      const payload = event.payload;
      return {
        ...next,
        lastActivity: payload.activity,
        activity: {
          startedId: event.id,
          activity: payload.activity,
          label: payload.label,
          motive: payload.motive,
          startedAt: event.at,
          endsAt: payload.endsAt,
          costPerHour: payload.costPerHour,
          satisfies: payload.satisfies,
          ...(payload.material ? { material: payload.material } : {}),
        },
        ...(payload.material?.kind === "passage"
          ? {
              reading: {
                ...state.reading,
                [payload.material.bookId]: payload.material.index + 1,
              },
            }
          : {}),
      };
    }
    case "activity.ended": {
      const drives = { ...next.drives };
      for (const drive of DRIVES) {
        drives[drive] = clamp(drives[drive] - (event.payload.satisfied[drive] ?? 0));
      }
      const { activity: _activity, ...rest } = next;
      return { ...rest, drives, lastEndedId: event.id };
    }
    case "felt": {
      const payload = event.payload;
      const reactivity = state.genome.temperament.reactivity;
      const mood = {
        valence: clamp(next.mood.valence + payload.valence * reactivity, -1, 1),
        arousal: clamp(next.mood.arousal + payload.arousal * reactivity, -1, 1),
      };
      const tastes = { ...state.tastes };
      if (payload.about) {
        const keys = payload.about.includes(":")
          ? [payload.about, payload.about.slice(0, payload.about.indexOf(":"))]
          : [payload.about];
        for (const key of keys) {
          const taste = tastes[key] ?? { sum: 0, count: 0, evidence: [] };
          tastes[key] = {
            sum: taste.sum + payload.valence,
            count: taste.count + 1,
            evidence: [...taste.evidence, event.id].slice(-8),
          };
        }
      }
      const tags = payload.tag ? { ...state.tags, [payload.tag]: event.at } : state.tags;
      return { ...next, mood, tastes, tags };
    }
    case "wrote":
    case "reflected":
    case "said": {
      const settled = applySaid(next, event);
      const external = event.kind === "said" && event.payload.external === true;
      return external || FREE_MINDS.has(event.payload.mind)
        ? settled
        : countMindCall(settled, event.at, timezone);
    }
    case "belief": {
      const payload = event.payload;
      return {
        ...next,
        beliefs: {
          ...state.beliefs,
          [payload.key]: {
            key: payload.key,
            stance: payload.stance,
            statement: payload.statement,
            evidence: payload.evidence,
            confidence: payload.confidence,
            eventId: event.id,
            at: event.at,
          },
        },
      };
    }
    case "heard": {
      const payload = event.payload;
      const known = state.people[payload.personId];
      const name = payload.name ?? known?.name;
      const drives = { ...next.drives, connection: clamp(next.drives.connection * 0.6) };
      return {
        ...next,
        drives,
        people: {
          ...state.people,
          [payload.personId]: {
            personId: payload.personId,
            ...(name ? { name } : {}),
            firstHeardAt: known?.firstHeardAt ?? event.at,
            lastHeardAt: event.at,
            exchanges: (known?.exchanges ?? 0) + 1,
          },
        },
        pending: state.asleep
          ? [...state.pending, { id: event.id, personId: payload.personId }]
          : state.pending,
      };
    }
    case "noted": {
      const payload = event.payload;
      const notes = { ...(state.notes[payload.personId] ?? {}) };
      notes[payload.topic] = {
        eventId: event.id,
        topic: payload.topic,
        text: payload.text,
        at: event.at,
        source: payload.source,
        pending: payload.done ? false : payload.pending === true,
      };
      return { ...next, notes: { ...state.notes, [payload.personId]: notes } };
    }
    case "recalled":
    case "episode":
    case "chapter":
      // What she remembers is not part of her state: the memory index reads it from the log.
      return next;
    case "mind.changed":
      return { ...next, mind: event.payload.to };
    case "lapsed": {
      // The host was off. She did not live through the gap, so she comes back asleep.
      const { activity: _activity, ...rest } = next;
      return { ...rest, asleep: true, since: event.at, sinceId: event.id, sinceKind: "lapsed" };
    }
    case "limited":
      return event.payload.tag ? { ...next, tags: { ...state.tags, [event.payload.tag]: event.at } } : next;
  }
}

function applySaid(state: LifeState, event: LifeEvent): LifeState {
  if (event.kind !== "said") return state;
  // A crisis reply is not an answer to everything else they said; that still gets one.
  if (event.payload.mind === SAFETY_MIND_NAME) return state;
  // One reply answers everything that person said while she was asleep.
  const personId = event.payload.personId;
  return { ...state, pending: state.pending.filter((item) => item.personId !== personId) };
}

function countMindCall(state: LifeState, at: number, timezone: string): LifeState {
  const day = dayKey(at, timezone);
  return day === state.mindDay
    ? { ...state, mindCallsToday: state.mindCallsToday + 1 }
    : { ...state, mindDay: day, mindCallsToday: 1 };
}

/** The state right after birth. */
function initial(event: LifeEvent<"born">): LifeState {
  const genome = event.payload.genome;
  return {
    lifeId: event.payload.lifeId,
    genome,
    bornAt: event.at,
    at: event.at,
    seq: event.seq,
    mind: event.payload.mind,
    asleep: true,
    since: event.at,
    sinceId: event.id,
    sinceKind: "born",
    energy: 0.8,
    drives: { curiosity: 0.5, expression: 0.2, connection: 0.2 },
    mood: { valence: genome.temperament.baselineValence, arousal: 0 },
    tastes: {},
    beliefs: {},
    reading: {},
    people: {},
    notes: {},
    pending: [],
    tags: {},
    mindDay: dayKey(event.at, genome.timezone),
    mindCallsToday: 0,
  };
}

/** Folds one more event into a state. */
export function fold(state: LifeState | undefined, event: LifeEvent): LifeState {
  if (!state) {
    if (event.kind !== "born") {
      throw new Error(`a life must begin with "born", got "${event.kind}"`);
    }
    return initial(event);
  }
  if (event.seq !== state.seq + 1) {
    throw new Error(`event ${event.id} is out of order: expected seq ${state.seq + 1}`);
  }
  if (event.at < state.at) {
    throw new Error(`event ${event.id} goes back in time`);
  }
  // Time in a lapse was not lived: nothing grows, nothing fades.
  const base = event.kind === "lapsed" ? { ...state, at: event.at } : advance(state, event.at);
  return apply(base, event);
}

/** Rebuilds a state from a whole log. */
export function replay(events: LifeEvent[]): LifeState | undefined {
  let state: LifeState | undefined;
  for (const event of events) {
    state = fold(state, event);
  }
  return state;
}
