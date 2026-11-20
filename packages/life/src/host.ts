import { advance } from "./state.js";
import type { Fact, GatherOptions } from "./facts.js";
import { gatherFacts } from "./facts.js";
import type { Recollection, RecallCue } from "./recall.js";
import type { LifeEvent } from "./events.js";
import { advanceDoFor } from "./heart.js";
import { clipText, findLast, type LifeInternals } from "./internal.js";

export interface StockInput {
  /** One word, the same as the activity that reads it, e.g. `news`. */
  shelf: string;
  /** The host's id for it, so it is never brought twice. */
  item: string;
  title: string;
  /** What she will read: a summary, a commit message and diffstat. Kept short in her life. */
  text: string;
  tags?: string[];
  source: string;
  link?: string;
}

/** An item's text in her life is a summary, not the whole article. */
const MAX_STOCKED_CHARS = 600;

export interface NoteInput {
  personId: string;
  topic: string;
  text: string;
  /** The `heard` event it comes from. */
  source: string;
  pending?: boolean;
  done?: boolean;
}

function shelfLabels(life: LifeInternals): Record<string, string> {
  return Object.fromEntries([...life.kinds.values()].flatMap((kind) => (kind.label ? [[kind.id, kind.label]] : [])));
}

/** The facts a mind would be given right now. */
export function facts(
  life: LifeInternals,
  options: Partial<Omit<GatherOptions, "memory">> = {},
): Fact[] {
  const now = Math.max(life.current.at, life.cursor);
  return gatherFacts(advance(life.current, now), life.log, {
    now,
    memory: life.memory,
    shelfLabels: shelfLabels(life),
    ...options,
  });
}

/** What a cue brings to mind on its own, without her looking for it. Changes nothing. */
export function recall(life: LifeInternals, cue: RecallCue): Recollection[] {
  return life.memory.recall(cue, Math.max(life.current.at, life.cursor));
}

/** She searches her memory on purpose; the search is recorded so what she found stays clear. */
export function remember(life: LifeInternals, cue: RecallCue): Promise<Recollection[]> {
  return life.serial(async () => {
    const at = Math.max(life.clock(), life.cursor);
    await life.catchUp(at);
    const found = life.memory.recall(cue, at, true);
    await life.emit(at, {
      kind: "recalled",
      payload: {
        cue: cue.text ?? "",
        found: found.map((item) => item.id),
        ...(cue.personId ? { personId: cue.personId } : {}),
      },
    });
    return found;
  });
}

/**
 * The host puts something on one of her shelves. She gets to it in her own time; nothing she
 * has already been through, or that is already waiting, is stocked again.
 */
export function stock(life: LifeInternals, input: StockInput): Promise<LifeEvent<"stocked"> | undefined> {
  return life.serial(async () => {
    const shelf = input.shelf.trim();
    const item = input.item.trim();
    const title = input.title.trim();
    if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(shelf)) throw new Error("stock() needs a one-word shelf");
    if (!item || item.length > 200) throw new Error("stock() needs the host's id for the item");
    if (!title) throw new Error("stock() needs a title");
    const at = Math.max(life.clock(), life.cursor);
    await life.catchUp(at);
    const state = life.current;
    if ((state.seen[shelf] ?? []).includes(item) || (state.shelves[shelf] ?? []).some((entry) => entry.item === item)) {
      return undefined;
    }
    return life.emit(at, {
      kind: "stocked",
      payload: {
        shelf,
        item,
        title: clipText(title, 120),
        text: clipText(input.text.trim(), MAX_STOCKED_CHARS),
        tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 6),
        source: input.source.trim() || shelf,
        ...(input.link ? { link: input.link } : {}),
      },
    });
  });
}

/** She keeps something she was told, resting on what that person actually said. */
export function note(life: LifeInternals, input: NoteInput): Promise<LifeEvent<"noted">> {
  return life.serial(async () => {
    const topic = input.topic.trim();
    const text = input.text.trim();
    if (!topic || topic.length > 40) throw new Error("a note needs a short topic");
    if (!text || text.length > 300) throw new Error("a note needs a short text");
    const source = findLast(life.log, (event) => event.id === input.source);
    if (source?.kind !== "heard" || source.payload.personId !== input.personId) {
      throw new Error(`${input.source} is not something ${input.personId} said to her`);
    }
    const at = Math.max(life.clock(), life.cursor);
    await life.catchUp(at);
    const noted = await life.emit(at, {
      kind: "noted",
      causes: [source.id],
      payload: {
        personId: input.personId,
        topic,
        text,
        source: source.id,
        ...(input.pending ? { pending: true } : {}),
        ...(input.done ? { done: true } : {}),
      },
    });
    await advanceDoFor(life, at, noted);
    return noted;
  });
}
