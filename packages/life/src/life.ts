import { randomUUID } from "node:crypto";
import { ACTIVITIES, type ActivityKind } from "./activities.js";
import { HOUR, MINUTE } from "./clock.js";
import { eventId, FREE_MINDS, type LifeArchive, type LifeEvent, type LifeEventKind, type LifeEventPayloads } from "./events.js";
import { describeEvent, whenLabel, type Fact, type GatherOptions } from "./facts.js";
import type { Genome } from "./genome.js";
import {
  catchUp as catchUpLife,
  feelTalk,
  live as liveLife,
  perceive,
  wakeFor,
  type PerceiveInput,
} from "./heart.js";
import {
  facts as hostFacts,
  note as hostNote,
  recall as hostRecall,
  remember as hostRemember,
  stock as hostStock,
  type NoteInput,
  type StockInput,
} from "./host.js";
import { checkGrounds, findLast, isEventId, type Draft, type LifeInternals } from "./internal.js";
import { InnerMind, type Mind } from "./mind.js";
import { MemoryIndex, memorySettings, type RecallCue, type Recollection } from "./recall.js";
import { crisis, emitHeard, reply, type HeardInput } from "./speech.js";
import { advance, dayKey, fold, replay, type LifeState } from "./state.js";
import type { World } from "./world.js";

export type { NoteInput, StockInput } from "./host.js";
export type { PerceiveInput } from "./heart.js";

export interface LifeOptions {
  /** Used only at birth. An existing life keeps the genome it was born with. */
  genome: Genome;
  world: World;
  archive: LifeArchive;
  /** Puts experience into words. Defaults to the built-in `InnerMind`. */
  mind?: Mind;
  clock?: () => number;
  lifeId?: string;
  activities?: ActivityKind[];
  /** Calls per local day to a mind that costs something. Default 48. */
  mindCallsPerDay?: number;
  /** If the host was off for longer than this, the gap is recorded as a lapse. Default 3 days. */
  maxCatchUpMs?: number;
  /** Fixed reply when someone seems to be in danger. Hosts must check the numbers for their region. */
  crisisReply?: string;
  /**
   * Who she may reach out to on her own. Without it she never does. She wants to when she has
   * missed them, when she came across something she thinks they would care about, or when
   * something she owes them is still open; the host decides how it reaches them.
   */
  reachOut?: { personIds: string[] };
  logger?: { warn(message: string, error?: unknown): void };
}

export interface HearInput {
  personId: string;
  name?: string;
  text: string;
  /** Where the host keeps the whole conversation, e.g. `dsh-session:<id>`. */
  where?: string;
}

export interface HearResult {
  heard: LifeEvent<"heard">;
  /** Missing when she was asleep; she answers after she wakes up. */
  said?: LifeEvent<"said">;
  asleep: boolean;
}

export interface ListenResult {
  heard: LifeEvent<"heard">;
  /** Present when the message woke her up. */
  woke?: LifeEvent<"woke">;
  /** Only the fixed crisis reply; every other answer is the host's, recorded with `speak()`. */
  said?: LifeEvent<"said">;
}

export interface SpeakInput {
  personId: string;
  /** The `heard` event this answers. */
  inReplyTo: string;
  text: string;
  /** Who put the words together, e.g. the host agent's model. Recorded as the `said` mind. */
  speaker: string;
  /** The facts the speaker was shown, usually from `facts()`. */
  offered?: Fact[];
  /** Ids of offered facts the text rests on. Ids that were not offered are kept as rejected. */
  grounds?: string[];
}

const CRISIS_PATTERN =/自杀|不想活|想死|活不下去|轻生|自残|割腕|结束自己|伤害自己|kill myself|suicide/iu;

export const DEFAULT_CRISIS_REPLY =
  "我在听，你说的话我很认真地对待。请现在就联系一个你信任的人，或者拨打 120 / 110；也可以打心理援助热线（中国大陆可拨 12356）。你不用一个人扛着。";

const MOTIVE_WORDS: Record<string, string> = {
  curiosity: "想看点新东西",
  expression: "心里有话想写下来",
  connection: "想找人说话",
  none: "累了，想歇一歇",
};

/**
 * A life. It goes on whether or not anyone is talking to it.
 *
 * Every change is an event appended to the archive; `state` is only the fold of those events.
 * Decisions use the state, the world and a seed, never the wall clock alone, so the same life
 * replayed over the same stretch of time makes the same choices.
 */
export class Life implements LifeInternals {
  current: LifeState;
  readonly log: LifeEvent[];
  readonly archive: LifeArchive;
  readonly world: World;
  readonly clock: () => number;
  readonly kinds: Map<string, ActivityKind>;
  readonly inner = new InnerMind();
  mind: Mind;
  readonly mindCallsPerDay: number;
  readonly maxCatchUpMs: number;
  readonly crisisReply: string;
  readonly reachOut: { personIds: string[] } | undefined;
  readonly logger: { warn(message: string, error?: unknown): void };
  private readonly listeners = new Set<(event: LifeEvent) => void>();
  readonly memory: MemoryIndex;
  private queue: Promise<unknown> = Promise.resolve();
  /** Time up to which decisions have been made; may be ahead of the last event. */
  cursor: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  private constructor(options: LifeOptions, log: LifeEvent[], state: LifeState) {
    this.archive = options.archive;
    this.world = options.world;
    this.clock = options.clock ?? Date.now;
    this.kinds = new Map((options.activities ?? ACTIVITIES).map((kind) => [kind.id, kind]));
    this.mind = options.mind ?? this.inner;
    this.mindCallsPerDay = Math.max(0, options.mindCallsPerDay ?? 48);
    this.maxCatchUpMs = options.maxCatchUpMs ?? 3 * 24 * HOUR;
    this.crisisReply = options.crisisReply ?? DEFAULT_CRISIS_REPLY;
    this.reachOut = options.reachOut;
    this.logger = options.logger ?? { warn: (message, error) => console.warn(message, error) };
    this.log = log;
    this.current = state;
    this.cursor = state.at;
    this.memory = new MemoryIndex(memorySettings(state.genome));
    for (const event of log) this.memory.add(event);
  }

  /** Opens a life from its archive, or gives birth to it when the archive is empty. */
  static async open(options: LifeOptions): Promise<Life> {
    const log = await options.archive.load();
    const restored = replay(log);
    const clock = options.clock ?? Date.now;
    const mindName = (options.mind ?? new InnerMind()).name;
    if (restored) {
      const life = new Life(options, log, restored);
      if (restored.mind !== mindName) {
        // The mind was swapped while she was not running: record it where her life left off,
        // so the time since then is still lived (or recorded as a lapse) by the next tick.
        await life.commit(restored.at, [
          { kind: "mind.changed", payload: { from: restored.mind, to: mindName } },
        ]);
      }
      return life;
    }
    const bornAt = clock();
    const born: LifeEvent<"born"> = {
      id: eventId(1),
      seq: 1,
      at: bornAt,
      kind: "born",
      causes: [],
      payload: { lifeId: options.lifeId ?? randomUUID(), genome: options.genome, mind: mindName },
    };
    await options.archive.append([born]);
    return new Life(options, [born], fold(undefined, born));
  }
  /** Everything she is right now. A copy; changing it changes nothing. */
  get state(): LifeState {
    return structuredClone(advance(this.current, Math.max(this.current.at, this.cursor)));
  }

  /** The whole life so far, oldest first. */
  events(): LifeEvent[] {
    return structuredClone(this.log);
  }

  /** Events of one local day (`YYYY-MM-DD`). */
  day(day: string): LifeEvent[] {
    const timezone = this.current.genome.timezone;
    return structuredClone(this.log.filter((event) => dayKey(event.at, timezone) === day));
  }

  get mindName(): string {
    return this.mind.name;
  }

  /** Called after every new event. Returns an unsubscribe function. */
  subscribe(listener: (event: LifeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lives up to `target`. Calling it in one step or many gives the same life. */
  advanceTo(target: number): Promise<void> {
    return this.serial(() => this.live(target));
  }

  /** Lives up to the host clock. After a long outage the gap is recorded, not lived. */
  tick(): Promise<void> {
    return this.serial(() => this.catchUp(this.clock()));
  }

  /** @internal */
  async catchUp(now: number): Promise<void> {
    return catchUpLife(this, now);
  }

  /** @internal */
  async live(target: number): Promise<void> {
    return liveLife(this, target);
  }

  /** Someone says something to her. She answers if she is awake, otherwise after she wakes. */
  hear(input: HearInput): Promise<HearResult> {
    return this.serial(async () => {
      const at = Math.max(this.clock(), this.cursor);
      await this.catchUp(at);
      const heard = await emitHeard(this, at, input);
      if (CRISIS_PATTERN.test(input.text)) {
        // A fixed reply, whatever mind she has and whether or not she is asleep.
        const said = await crisis(this, at, heard);
        return { heard, said, asleep: this.current.asleep };
      }
      if (this.current.asleep) {
        return { heard, asleep: true };
      }
      await feelTalk(this, at, heard);
      const said = await reply(this, at, heard);
      return { heard, said, asleep: false };
    });
  }

  /**
   * Someone says something to her and the host answers, not her own mind: she hears it, wakes up
   * if she was asleep, and feels it. Record the answer with `speak()`. Only a crisis is answered
   * here, with the fixed reply.
   */
  listen(input: HearInput): Promise<ListenResult> {
    return this.serial(async () => {
      const at = Math.max(this.clock(), this.cursor);
      await this.catchUp(at);
      const heard = await emitHeard(this, at, input);
      const isCrisis = CRISIS_PATTERN.test(input.text);
      const woke = this.current.asleep ? await wakeFor(this, at, heard, !isCrisis) : undefined;
      if (isCrisis) {
        const said = await crisis(this, at, heard);
        return { heard, said, ...(woke ? { woke } : {}) };
      }
      await feelTalk(this, at, heard);
      return { heard, ...(woke ? { woke } : {}) };
    });
  }

  /**
   * Records words the host said to someone on her behalf. They become part of her life like her
   * own replies: later facts include them, and the grounds are checked against what was offered.
   */
  speak(input: SpeakInput): Promise<LifeEvent<"said">> {
    return this.serial(async () => {
      const text = input.text.trim();
      if (!text) throw new Error("speak() needs something to say");
      if (FREE_MINDS.has(input.speaker)) {
        throw new Error(`"${input.speaker}" is reserved for the kernel's own voices`);
      }
      const heard = findLast(this.log, (event) => event.id === input.inReplyTo);
      // An answer to what they said, or the words of an urge of her own to talk to them.
      const fits =
        (heard?.kind === "heard" || heard?.kind === "urged") && heard.payload.personId === input.personId;
      if (!heard || !fits) {
        throw new Error(`${input.inReplyTo} is not something ${input.personId} said to her, or an urge to talk to them`);
      }
      const at = Math.max(this.clock(), this.cursor);
      await this.catchUp(at);
      const grounding = checkGrounds(input.offered ?? [], input.grounds ?? []);
      return this.emit(at, {
        kind: "said",
        causes: [heard.id, ...grounding.grounds.filter(isEventId)],
        payload: {
          personId: input.personId,
          text,
          inReplyTo: heard.id,
          mind: input.speaker,
          external: true,
          ...grounding,
        },
      });
    });
  }

  /** Swaps the mind. Who she is stays in the log; the new mind reads the same life. */
  setMind(mind: Mind): Promise<void> {
    return this.serial(async () => {
      if (mind.name === this.mind.name) {
        this.mind = mind;
        return;
      }
      const from = this.mind.name;
      // Live up to now with the old mind first: what happened before the swap was its doing.
      const at = Math.max(this.clock(), this.cursor);
      await this.catchUp(at);
      await this.emit(at, { kind: "mind.changed", payload: { from, to: mind.name } });
      this.mind = mind;
    });
  }

  /** The facts a mind would be given right now. With a `cue`, what it brings to mind is included. */
  facts(options: Partial<Omit<GatherOptions, "memory">> = {}): Fact[] {
    return hostFacts(this, options);
  }

  /**
   * What a cue brings to mind on its own, without her looking for it. Changes nothing: a memory
   * that merely surfaces is not strengthened, only one that is used.
   */
  recall(cue: RecallCue): Recollection[] {
    return hostRecall(this, cue);
  }

  /**
   * The host puts something on one of her shelves. She gets to it in her own time, when she
   * feels like that pastime and it is what she is most drawn to; nothing she has already been
   * through, or that is already waiting, is stocked again. Asleep or awake makes no difference:
   * a newspaper arrives at night too.
   *
   * @returns the `stocked` event, or undefined when she already has it.
   */
  stock(input: StockInput): Promise<LifeEvent<"stocked"> | undefined> {
    return hostStock(this, input);
  }

  /**
   * Something outside her room happens and she notices it. It enters as a logged event, so her
   * life stays a function of the log: replayed, she notices it again in the same way. Asleep, she
   * does not notice anything and nothing is recorded.
   *
   * The host may say how pleasant it is, but only a little of that reaches her: how she feels
   * about it is her own (a seeded affinity, like everything else she likes), and the same thing
   * many times in a day stops being news.
   */
  perceive(input: PerceiveInput): Promise<LifeEvent<"perceived"> | undefined> {
    return perceive(this, input);
  }

  /**
   * She keeps something she was told. It must rest on something that person said to her; a note
   * on a topic she already has replaces the old one, which stays in the log.
   */
  note(input: NoteInput): Promise<LifeEvent<"noted">> {
    return hostNote(this, input);
  }

  /**
   * She searches her memory on purpose. Everything that matches comes back, clear or not, and
   * the search is recorded: what she found this way stays clear for longer.
   */
  remember(cue: RecallCue): Promise<Recollection[]> {
    return hostRemember(this, cue);
  }

  /** The event and everything that led to it, oldest first. */
  explain(id: string): LifeEvent[] {
    const byId = new Map(this.log.map((event) => [event.id, event]));
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next || seen.has(next)) continue;
      const event = byId.get(next);
      if (!event) continue;
      seen.add(next);
      stack.push(...event.causes);
    }
    return [...seen]
      .map((key) => byId.get(key))
      .filter((event): event is LifeEvent => Boolean(event))
      .sort((left, right) => left.seq - right.seq)
      .map((event) => structuredClone(event));
  }

  /** `explain()` in words, one line per event. */
  narrate(id: string): string[] {
    const now = Math.max(this.current.at, this.cursor);
    const timezone = this.current.genome.timezone;
    return this.explain(id).map((event) => {
      const text = describeLine(event, now, timezone);
      return `[${event.id}] ${text}`;
    });
  }

  /** Keeps her alive on the host clock until `stop()`. */
  start(intervalMs = MINUTE): void {
    if (this.running) return;
    this.running = true;
    const loop = (): void => {
      if (!this.running) return;
      this.tick()
        .catch((error: unknown) => this.logger.warn("life tick failed", error))
        .finally(() => {
          if (!this.running) return;
          this.timer = setTimeout(loop, intervalMs);
          this.timer.unref?.();
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.queue.catch(() => undefined);
  }
  // ---------------------------------------------------------------------------------------------
  // The log

  async emit<K extends LifeEventKind>(
    at: number,
    draft: { kind: K; payload: LifeEventPayloads[K]; causes?: string[] },
  ): Promise<LifeEvent<K>> {
    const [event] = await this.commit(at, [draft as Draft]);
    return event as LifeEvent<K>;
  }

  /** Writes events to the archive first, then folds them in. A failed write changes nothing. */
  async commit(at: number, drafts: Draft[]): Promise<LifeEvent[]> {
    const time = Math.max(at, this.current.at);
    let state = this.current;
    const events: LifeEvent[] = [];
    for (const draft of drafts) {
      const seq = state.seq + 1;
      const event = {
        id: eventId(seq),
        seq,
        at: time,
        kind: draft.kind,
        causes: [...new Set(draft.causes ?? [])],
        payload: structuredClone(draft.payload),
      } as LifeEvent;
      state = fold(state, event);
      events.push(event);
    }
    await this.archive.append(events);
    this.log.push(...events);
    for (const event of events) this.memory.add(event);
    this.current = state;
    this.cursor = Math.max(this.cursor, time);
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(event));
        } catch (error: unknown) {
          this.logger.warn("life listener failed", error);
        }
      }
    }
    return events;
  }

  /** Runs one change at a time, in call order, so the log never interleaves. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function describeLine(event: LifeEvent, now: number, timezone: string): string {
  if (event.kind === "activity.started") {
    const motive = MOTIVE_WORDS[event.payload.motive] ?? "";
    return `${describeEvent(event, now, timezone) ?? event.kind}（因为${motive}）`;
  }
  if (event.kind === "activity.ended") {
    return `${whenLabel(event.at, now, timezone)} ${event.payload.label}结束`;
  }
  return describeEvent(event, now, timezone) ?? event.kind;
}
