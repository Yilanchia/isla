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

/** What an activity was about: the passage she read, the view she looked at. */
export type Material = PassageMaterial | ViewMaterial;

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
  wrote: { text: string; mind: string } & Grounding;
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
  heard: { personId: string; name?: string; text: string };
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
