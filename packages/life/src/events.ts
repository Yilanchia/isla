import type { Genome } from "./genome.js";

/**
 * Inner needs. They grow while unmet and fall when an activity satisfies them. Rest is not a
 * drive here: it is `energy`, a body variable that sleep restores.
 */
export const DRIVES = ["curiosity", "expression", "connection"] as const;
export type Drive = (typeof DRIVES)[number];
export type DriveLevels = Record<Drive, number>;

export interface PassageMaterial {
  kind: "passage";
  bookId: string;
  title: string;
  /** Position in the book; may exceed the book length when she rereads it. */
  index: number;
  text: string;
  reread: boolean;
}

export interface ViewMaterial {
  kind: "view";
  text: string;
}

/** Something the host put on one of her shelves: an article, a commit, an episode. */
export interface ItemMaterial {
  kind: "item";
  shelf: string;
  item: string;
  title: string;
  text: string;
  tags: string[];
  /** The `stocked` event it came in with. */
  stockedId: string;
  link?: string;
}

/** What an activity was about: the passage she read, the view she looked at, the item she picked up. */
export type Material = PassageMaterial | ViewMaterial | ItemMaterial;

/** Says what a piece of speech or writing rests on. */
export interface Grounding {
  /** Fact ids the text rests on; every one was among the facts the mind was given. */
  grounds: string[];
  /** Ids the mind cited that it was never given. Kept, so a confabulating mind shows up. */
  rejected: string[];
  /** The text of each grounded fact, so the speech can be audited without re-deriving it. */
  facts: Record<string, string>;
}

/** What a consolidated memory stands for. */
export interface Consolidation {
  /** The span of time it sums up. */
  from: number;
  to: number;
  summary: string;
  /** Every memory it stands for; asked about that time, these are what it zooms into. */
  covers: string[];
  /** The ones its summary actually mentions. Going over them in sleep counts as using them. */
  kept: string[];
}

/**
 * Every kind of thing that can happen in a life, and what it carries.
 *
 * The log of these events is the life. Her state, her memories and her picture of herself are
 * all computed from it, so anything she says about herself can be traced back to an event.
 */
export interface LifeEventPayloads {
  born: { lifeId: string; genome: Genome; mind: string };
  woke: {
    reason: string;
    /** The `heard` event that woke her, when someone called her out of sleep. */
    by?: string;
  };
  slept: { reason: string };
  perceived: {
    what: string;
    source: string;
    /** Machine-readable value, e.g. the weather kind `小雨`. */
    detail?: string;
    valence: number;
    novelty: number;
    material?: Material;
  };
  "activity.started": {
    activity: string;
    label: string;
    motive: Drive | "none";
    /** Drive levels at the moment she chose this, kept so the choice can be explained later. */
    drives: DriveLevels;
    endsAt: number;
    costPerHour: number;
    satisfies: Partial<DriveLevels>;
    material?: Material;
  };
  "activity.ended": {
    activity: string;
    label: string;
    startedId: string;
    satisfied: Partial<DriveLevels>;
    interrupted: boolean;
  };
  felt: {
    valence: number;
    arousal: number;
    reason: string;
    /** The activity this feeling was about; it is how she learns what she likes. */
    about?: string;
    /** Marks feelings the kernel must not repeat within a day, e.g. "lonely". */
    tag?: string;
  };
  wrote: {
    text: string;
    mind: string;
    /** What it is about, e.g. `read:zhuangzi` or `item:news:42`; what a `make` goal counts. */
    about?: string;
  } & Grounding;
  /** A finished piece: the notes she wrote about one thing, put together. */
  made: { title: string; text: string; about: string; mind: string } & Grounding;
  reflected: {
    diary: string;
    mind: string;
    /** Local date of the day she is looking back on, `YYYY-MM-DD`. */
    day: string;
  } & Grounding;
  belief: {
    key: string;
    stance: "like" | "dislike" | "unsure";
    statement: string;
    evidence: string[];
    confidence: number;
  };
  heard: {
    personId: string;
    name?: string;
    text: string;
    /**
     * Where the conversation is kept in full, in the host's terms, e.g. `dsh-session:<id>`. Her
     * life keeps what was said; the host keeps everything around it (files, commands, tool output).
     */
    where?: string;
  };
  said: {
    personId: string;
    text: string;
    inReplyTo: string;
    mind: string;
    /**
     * Words put together by the host's own agent and recorded with `speak()`, not by one of her
     * minds. They do not count against her mind budget.
     */
    external?: boolean;
  } & Grounding;
  /**
   * She has come to know someone better: 初识 → 熟悉 → 亲近 → 信赖. Computed from how long and how
   * often they have talked and how she has felt about it; it only ever deepens.
   */
  bonded: {
    personId: string;
    bond: "stranger" | "familiar" | "close" | "trusted";
    /** In her words: "认识 12 天了，聊过 6 天". */
    because: string;
  };
  /**
   * She set herself something to do across days: finish a book, make a thing, learn about
   * something, keep a promise to someone. The mind proposes it and the kernel accepts it only
   * when it rests on facts she was given.
   */
  aimed: {
    goalId: string;
    kind: "finish" | "make" | "learn" | "do-for";
    /** Machine-readable object: `read:zhuangzi`, `person:p1:护照`. */
    about: string;
    /** In her words: "读完《庄子》". */
    statement: string;
    /** How much she wants it, 0..1. */
    need: number;
    mind: string;
  } & Grounding;
  /** She moved a goal forward. `by` is the event that did it; `amount` is in the goal's own units. */
  progressed: { goalId: string; by: string; amount: number };
  achieved: { goalId: string };
  dropped: { goalId: string; reason: string };
  /**
   * She wants to say something to someone who is not talking to her right now. The kernel decides
   * that she wants to and why, from what has happened; the host decides how it reaches them, and
   * records what was said with `speak()` against this event.
   */
  urged: {
    personId: string;
    /** `missed`: she has not heard from them in a long while. `share`: something she came across. `pending`: something still to do for them. */
    why: "missed" | "share" | "pending";
    /** What it is about, in her words. */
    about: string;
  };
  /**
   * The host put something on one of her shelves for her to get to in her own time: a news
   * article, a commit in a project, an episode of a show. It enters the log with its text, so a
   * replayed life reads exactly what she read.
   */
  stocked: {
    shelf: string;
    /** The host's id for it; the same id is never stocked twice on a shelf. */
    item: string;
    title: string;
    text: string;
    /** What it is about, for her tastes, e.g. `["AI", "芯片"]`. */
    tags: string[];
    /** Where it came from, e.g. the feed's name or the repository. */
    source: string;
    link?: string;
  };
  /**
   * Something she was told and decided to keep: a fact about someone, a request, a promise. It
   * must come from something that person said; the kernel checks. A later note on the same topic
   * replaces this one, and both stay in the log.
   */
  noted: {
    personId: string;
    /** A short key, e.g. `饮食禁忌` or `生日:母亲`. */
    topic: string;
    text: string;
    /** The `heard` event it comes from. */
    source: string;
    /** Something still to be done: a promise, a request, a reminder. */
    pending?: boolean;
    /** Closes what was pending on this topic. */
    done?: boolean;
  };
  /**
   * She searched her memory on purpose. Every id found counts as using that memory, which keeps
   * it clear for longer; memories that only came to mind on their own are not recorded.
   */
  recalled: {
    cue: string;
    /** Ids of the events she found, best first. Empty when nothing came back. */
    found: string[];
    /** Who asked, when she was looking something up for someone. */
    personId?: string;
  };
  /**
   * Asleep, she sorts one stretch of a day into a single memory. Written by the kernel from the
   * events themselves, so it says nothing they do not.
   */
  episode: Consolidation & {
    /** Local date the stretch belongs to, `YYYY-MM-DD`. */
    day: string;
    /** 上午, 下午, 晚上 or 夜里. */
    part: string;
  };
  /** A week or a month, looked back on: what the episodes in it add up to. */
  chapter: Consolidation & {
    span: "week" | "month";
    /** "11月2日到11月8日", "2026年11月". */
    label: string;
  };
  "mind.changed": { from: string; to: string };
  /** She was not running: the host was off for longer than she can catch up on. */
  lapsed: { from: number; to: number };
  /** Something she wanted to do could not happen in full: no budget, a failing mind. */
  limited: { what: string; reason: string; tag?: string };
}

export type LifeEventKind = keyof LifeEventPayloads;

export type LifeEvent<K extends LifeEventKind = LifeEventKind> = {
  [P in K]: {
    /** `e<seq>`: stable, readable, and identical when the same life is replayed. */
    id: string;
    seq: number;
    at: number;
    kind: P;
    /** Events that led to this one. `explain()` walks these back. */
    causes: string[];
    payload: LifeEventPayloads[P];
  };
}[K];

export function eventId(seq: number): string {
  return `e${seq}`;
}

/** Name of the built-in mind; its calls are free and do not count against the mind budget. */
export const INNER_MIND_NAME = "inner";
/** Name recorded when a fixed safety reply is used instead of any mind. */
export const SAFETY_MIND_NAME = "safety";
export const FREE_MINDS: ReadonlySet<string> = new Set([INNER_MIND_NAME, SAFETY_MIND_NAME]);

/** Where a life is kept. One writer at a time; `Life` serializes its own writes. */
export interface LifeArchive {
  load(): Promise<LifeEvent[]>;
  append(events: LifeEvent[]): Promise<void>;
}

export class MemoryArchive implements LifeArchive {
  private readonly events: LifeEvent[];

  constructor(events: LifeEvent[] = []) {
    this.events = structuredClone(events);
  }

  async load(): Promise<LifeEvent[]> {
    return structuredClone(this.events);
  }

  async append(events: LifeEvent[]): Promise<void> {
    this.events.push(...structuredClone(events));
  }

  /** A copy of everything stored, for tests. */
  snapshot(): LifeEvent[] {
    return structuredClone(this.events);
  }
}
