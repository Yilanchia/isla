import type { Drive, DriveLevels, Material } from "./events.js";
import type { LifeState } from "./state.js";
import type { World } from "./world.js";
import { hashString } from "./random.js";
import { MINUTE } from "./clock.js";

export interface ActivityContext {
  state: LifeState;
  world: World;
  /** Seeded for this one decision, so the same life makes the same choice. */
  random: () => number;
  now: number;
}

export interface ActivityPlan {
  activity: string;
  label: string;
  durationMs: number;
  /** Energy per hour; negative means it restores energy. */
  costPerHour: number;
  satisfies: Partial<DriveLevels>;
  material?: Material;
}

export interface Feeling {
  valence: number;
  arousal: number;
  reason: string;
  /** Taste key, e.g. `read:zhuangzi`. The part before ":" is learned as well. */
  about: string;
}

/**
 * One thing she can do with her time. `utility` says how much she wants to right now
 * (`undefined` = not possible); `feel` says how it turned out. Neither calls a model: a life
 * must keep going when no language model is reachable.
 */
export interface ActivityKind {
  id: string;
  /** The drive this mainly answers, used to explain the choice. */
  motive: Drive | "none";
  utility(context: ActivityContext): number | undefined;
  plan(context: ActivityContext): ActivityPlan;
  feel(context: ActivityContext, material: Material | undefined): Feeling;
}

export function tasteMean(state: LifeState, key: string): number {
  const taste = state.tastes[key];
  return taste && taste.count > 0 ? taste.sum / taste.count : 0;
}

/** A hidden, inborn affinity for something, in [-1, 1]. She only finds out by living. */
export function affinity(state: LifeState, key: string): number {
  return ((hashString(`${state.genome.seed}:${key}`) % 2001) - 1000) / 1000;
}

function inclination(state: LifeState, id: string): number {
  return state.genome.inclinations[id] ?? 0;
}

function between(random: () => number, minMinutes: number, maxMinutes: number): number {
  return Math.round(minMinutes + random() * (maxMinutes - minMinutes)) * MINUTE;
}

function noise(random: () => number, size: number): number {
  return (random() - 0.5) * size;
}

const read: ActivityKind = {
  id: "read",
  motive: "curiosity",
  utility({ state, world }) {
    if (world.books.length === 0 || state.energy < 0.25) return undefined;
    return state.drives.curiosity + inclination(state, "read") + tasteMean(state, "read") * 0.5;
  },
  plan({ state, world, random }) {
    const scored = world.books.map((book) => {
      const index = state.reading[book.id] ?? 0;
      const unread = index < book.passages.length ? 0.05 : -0.05;
      return { book, index, score: tasteMean(state, `read:${book.id}`) + unread + random() * 0.1 };
    });
    scored.sort((left, right) => right.score - left.score);
    const { book, index } = scored[0] ?? { book: world.books[0]!, index: 0 };
    const text = book.passages[index % book.passages.length] ?? "";
    const reread = index >= book.passages.length;
    return {
      activity: "read",
      label: reread ? `重读《${book.title}》` : `读《${book.title}》`,
      durationMs: between(random, 40, 70),
      costPerHour: 0.06,
      satisfies: { curiosity: reread ? 0.2 : 0.38 },
      material: { kind: "passage", bookId: book.id, title: book.title, index, text, reread },
    };
  },
  feel({ state, random }, material) {
    const bookId = material?.kind === "passage" ? material.bookId : "unknown";
    // Rereading a passage she already knows is pleasant, just less so.
    const book = material?.kind === "passage" ? material : undefined;
    const reread = book?.reread === true;
    const valence =
      0.04 +
      affinity(state, `read:${bookId}`) * 0.07 +
      inclination(state, "read") * 0.3 +
      (state.energy < 0.3 ? -0.05 : 0) +
      noise(random, 0.08);
    const title = material?.kind === "passage" ? `《${material.title}》` : "书";
    const reason =
      valence > 0.07
        ? `读${title}读得很入迷`
        : valence < -0.01
          ? `读${title}的时候有点读不进去`
          : `读完了一段${title}`;
    return { valence: reread ? valence * 0.5 : valence, arousal: 0.05, reason, about: `read:${bookId}` };
  },
};

const gaze: ActivityKind = {
  id: "gaze",
  motive: "curiosity",
  utility({ state }) {
    return 0.12 + state.drives.curiosity * 0.4 + inclination(state, "gaze") + tasteMean(state, "gaze") * 0.5;
  },
  plan({ world, now, state, random }) {
    return {
      activity: "gaze",
      label: "在窗边看外面",
      durationMs: between(random, 15, 30),
      costPerHour: 0.02,
      satisfies: { curiosity: 0.12 },
      material: { kind: "view", text: world.view(now, state.genome.timezone) },
    };
  },
  feel({ state, world, now, random }) {
    const weather = world.weather(now, state.genome.timezone);
    const valence =
      0.02 +
      world.pleasantness(weather) +
      affinity(state, `gaze:${weather}`) * 0.06 +
      inclination(state, "gaze") * 0.3 +
      noise(random, 0.06);
    const reason = valence > 0.06 ? `看着外面，${weather}天让人很舒服` : `看了一会儿${weather}天的窗外`;
    return { valence, arousal: -0.03, reason, about: `gaze:${weather}` };
  },
};

const write: ActivityKind = {
  id: "write",
  motive: "expression",
  utility({ state }) {
    if (state.energy < 0.2) return undefined;
    return state.drives.expression * 1.2 + inclination(state, "write") + tasteMean(state, "write") * 0.5;
  },
  plan({ random }) {
    return {
      activity: "write",
      label: "在笔记本上写东西",
      durationMs: between(random, 25, 40),
      costPerHour: 0.07,
      satisfies: { expression: 0.55 },
    };
  },
  feel({ state, random }) {
    const valence = 0.05 + affinity(state, "write") * 0.06 + inclination(state, "write") * 0.3 + noise(random, 0.08);
    const reason = valence > 0.07 ? "把想说的写下来，心里轻松了一点" : "写了一些东西";
    return { valence, arousal: 0.06, reason, about: "write" };
  },
};

const rest: ActivityKind = {
  id: "rest",
  motive: "none",
  utility({ state }) {
    return (0.45 - state.energy) * 2 + inclination(state, "rest") + tasteMean(state, "rest") * 0.5;
  },
  plan({ random }) {
    return {
      activity: "rest",
      label: "靠在椅子上休息",
      durationMs: between(random, 30, 50),
      costPerHour: -0.06,
      satisfies: {},
    };
  },
  feel({ state, random }) {
    const valence = 0.02 + affinity(state, "rest") * 0.04 + noise(random, 0.04);
    return { valence, arousal: -0.1, reason: "休息了一会儿", about: "rest" };
  },
};

export const ACTIVITIES: ActivityKind[] = [read, gaze, write, rest];

/** Human label for a taste key, used when she puts a pattern into words. */
export function tasteLabel(key: string, world: World, names: Record<string, string> = {}): string {
  if (key.startsWith("read:")) {
    const book = world.books.find((item) => `read:${item.id}` === key);
    return book ? `读《${book.title}》` : "读这本书";
  }
  if (key.startsWith("gaze:")) return `${key.slice("gaze:".length)}天看窗外`;
  if (key.startsWith("weather:")) return `${key.slice("weather:".length)}天`;
  if (key.startsWith("talk:")) {
    const id = key.slice("talk:".length);
    return `和${names[id] ?? id}说话`;
  }
  switch (key) {
    case "talk":
      return "和人说话";
    case "read":
      return "读书";
    case "gaze":
      return "看窗外";
    case "write":
      return "写东西";
    case "rest":
      return "什么都不做地休息";
    default:
      return key;
  }
}
