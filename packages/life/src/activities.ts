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
  /** How she says it, for tastes about the activity as a whole, e.g. "看新闻". */
  label?: string;
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

/** One of her pastimes that draws on a shelf the host keeps stocked. */
export interface ShelfActivityOptions {
  /** Activity id and shelf name, e.g. `news`. */
  id: string;
  /** "看新闻", "翻主人的项目". */
  label: string;
  /** How she comes to an item, e.g. "读到" or "翻到". */
  verb: string;
  motive?: Drive;
  minutes?: [number, number];
  costPerHour?: number;
  satisfies?: Partial<DriveLevels>;
}

/**
 * A pastime over a shelf. She picks what she is most drawn to, by the tags she has come to like,
 * and nothing when the shelf is empty. How it felt is hers: an inborn affinity per tag, which she
 * only finds out by living, the same as with books.
 */
export function shelfActivity(options: ShelfActivityOptions): ActivityKind {
  const { id, label, verb } = options;
  const [shortest, longest] = options.minutes ?? [15, 35];
  const appeal = (state: LifeState, tags: string[]) =>
    tags.length === 0 ? 0 : tags.reduce((sum, tag) => sum + tasteMean(state, `${id}:${tag}`), 0) / tags.length;
  return {
    id,
    label,
    motive: options.motive ?? "curiosity",
    utility({ state }) {
      const shelf = state.shelves[id] ?? [];
      if (shelf.length === 0 || state.energy < 0.2) return undefined;
      // A full shelf pulls a little more; what she has come to like pulls more still.
      return state.drives.curiosity + inclination(state, id) + tasteMean(state, id) * 0.5 + Math.min(shelf.length, 10) * 0.01;
    },
    plan({ state, random }) {
      const shelf = state.shelves[id] ?? [];
      const scored = shelf.map((entry, index) => ({
        entry,
        // Newer things first by a little, liked things first by more, and some chance.
        score: appeal(state, entry.tags) + index * 0.002 + random() * 0.05,
      }));
      scored.sort((left, right) => right.score - left.score);
      const entry = scored[0]!.entry;
      return {
        activity: id,
        label,
        durationMs: between(random, shortest, longest),
        costPerHour: options.costPerHour ?? 0.05,
        satisfies: options.satisfies ?? { curiosity: 0.3 },
        material: {
          kind: "item",
          shelf: id,
          item: entry.item,
          title: entry.title,
          text: entry.text,
          tags: entry.tags,
          stockedId: entry.stockedId,
          ...(entry.link ? { link: entry.link } : {}),
        },
      };
    },
    feel({ state, random }, material) {
      const tags = material?.kind === "item" ? material.tags : [];
      const tag = tags[0];
      const inborn = tags.length === 0 ? 0 : tags.reduce((sum, item) => sum + affinity(state, `${id}:${item}`), 0) / tags.length;
      const valence = 0.03 + inborn * 0.07 + inclination(state, id) * 0.3 + (state.energy < 0.3 ? -0.04 : 0) + noise(random, 0.08);
      const title = material?.kind === "item" ? `「${material.title}」` : "";
      const reason =
        valence > 0.07 ? `${verb}${title}，挺有意思` : valence < -0.01 ? `${verb}${title}，没什么意思` : `${verb}${title}`;
      return { valence, arousal: 0.05, reason, about: tag ? `${id}:${tag}` : id };
    },
  };
}

/** Human label for a taste key, used when she puts a pattern into words. */
export function tasteLabel(
  key: string,
  world: World,
  names: Record<string, string> = {},
  labels: Record<string, string> = {},
): string {
  if (labels[key]) return labels[key];
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
  // Perceptions from the host: `source:detail`. The detail is the host's own word for the thing.
  if (key.includes(":")) return key.slice(key.indexOf(":") + 1);
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
