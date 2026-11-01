import { randomUUID } from "node:crypto";
import { localTime } from "@isla/core";
import { ACTIVITIES, affinity, tasteLabel, type ActivityContext, type ActivityKind } from "./activities.js";
import { HOUR, MINUTE, isWakingHour, nextLocalHour } from "./clock.js";
import {
  eventId,
  FREE_MINDS,
  SAFETY_MIND_NAME,
  type DriveLevels,
  type Grounding,
  type LifeArchive,
  type LifeEvent,
  type LifeEventKind,
  type LifeEventPayloads,
} from "./events.js";
import { describeEvent, gatherFacts, whenLabel, type Fact, type GatherOptions } from "./facts.js";
import type { Genome } from "./genome.js";
import { InnerMind, type Mind, type MindRequest } from "./mind.js";
import { seededRandom } from "./random.js";
import { MemoryIndex, memorySettings, type RecallCue, type Recollection } from "./recall.js";
import { advance, dayKey, fold, replay, type LifeState } from "./state.js";
import { describeWeather, type World } from "./world.js";

type Draft = {
  [K in LifeEventKind]: { kind: K; payload: LifeEventPayloads[K]; causes?: string[] };
}[LifeEventKind];

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
  logger?: { warn(message: string, error?: unknown): void };
}

export interface HearInput {
  personId: string;
  name?: string;
  text: string;
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

/** After being woken, she stays up while someone keeps talking to her. */
const CONVERSATION_MS = 20 * MINUTE;
/** Woken in the night and back asleep within this long: it was an interruption, not a day. */
const INTERRUPTION_MS = 3 * HOUR;

const CRISIS_PATTERN =/自杀|不想活|想死|活不下去|轻生|自残|割腕|结束自己|伤害自己|kill myself|suicide/iu;

export const DEFAULT_CRISIS_REPLY =
  "我在听，你说的话我很认真地对待。请现在就联系一个你信任的人，或者拨打 120 / 110；也可以打心理援助热线（中国大陆可拨 12356）。你不用一个人扛着。";

const LONELY_THRESHOLD = 0.85;
const EXHAUSTED_ENERGY = 0.1;
const WEATHER_HOURS = [0, 6, 12, 18];

const MOTIVE_WORDS: Record<string, string> = {
  curiosity: "想看点新东西",
  expression: "心里有话想写下来",
  connection: "想找人说话",
  none: "累了，想歇一歇",
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundDrives(drives: DriveLevels): DriveLevels {
  return {
    curiosity: round(drives.curiosity),
    expression: round(drives.expression),
    connection: round(drives.connection),
  };
}

function seqOf(id: string): number {
  return Number(id.slice(1));
}

/**
 * A life. It goes on whether or not anyone is talking to it.
 *
 * Every change is an event appended to the archive; `state` is only the fold of those events.
 * Decisions use the state, the world and a seed, never the wall clock alone, so the same life
 * replayed over the same stretch of time makes the same choices.
 */
export class Life {
  private current: LifeState;
  private readonly log: LifeEvent[];
  private readonly archive: LifeArchive;
  private readonly world: World;
  private readonly clock: () => number;
  private readonly kinds: Map<string, ActivityKind>;
  private readonly inner = new InnerMind();
  private mind: Mind;
  private readonly mindCallsPerDay: number;
  private readonly maxCatchUpMs: number;
  private readonly crisisReply: string;
  private readonly logger: { warn(message: string, error?: unknown): void };
  private readonly listeners = new Set<(event: LifeEvent) => void>();
  private readonly memory: MemoryIndex;
  private queue: Promise<unknown> = Promise.resolve();
  /** Time up to which decisions have been made; may be ahead of the last event. */
  private cursor: number;
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

  /** Someone says something to her. She answers if she is awake, otherwise after she wakes. */
  hear(input: HearInput): Promise<HearResult> {
    return this.serial(async () => {
      const at = Math.max(this.clock(), this.cursor);
      await this.catchUp(at);
      const heard = await this.emitHeard(at, input);
      if (CRISIS_PATTERN.test(input.text)) {
        // A fixed reply, whatever mind she has and whether or not she is asleep.
        const said = await this.crisis(at, heard);
        return { heard, said, asleep: this.current.asleep };
      }
      if (this.current.asleep) {
        return { heard, asleep: true };
      }
      await this.feelTalk(at, heard);
      const said = await this.reply(at, heard);
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
      const heard = await this.emitHeard(at, input);
      const crisis = CRISIS_PATTERN.test(input.text);
      const woke = this.current.asleep ? await this.wakeFor(at, heard, !crisis) : undefined;
      if (crisis) {
        const said = await this.crisis(at, heard);
        return { heard, said, ...(woke ? { woke } : {}) };
      }
      await this.feelTalk(at, heard);
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
      const heard = this.log.find((event) => event.id === input.inReplyTo);
      if (heard?.kind !== "heard" || heard.payload.personId !== input.personId) {
        throw new Error(`${input.inReplyTo} is not something ${input.personId} said to her`);
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
    const now = Math.max(this.current.at, this.cursor);
    return gatherFacts(this.state, this.log, { now, memory: this.memory, ...options });
  }

  /**
   * What a cue brings to mind on its own, without her looking for it. Changes nothing: a memory
   * that merely surfaces is not strengthened, only one that is used.
   */
  recall(cue: RecallCue): Recollection[] {
    return this.memory.recall(cue, Math.max(this.current.at, this.cursor));
  }

  /**
   * She searches her memory on purpose. Everything that matches comes back, clear or not, and
   * the search is recorded: what she found this way stays clear for longer.
   */
  remember(cue: RecallCue): Promise<Recollection[]> {
    return this.serial(async () => {
      const at = Math.max(this.clock(), this.cursor);
      await this.catchUp(at);
      const found = this.memory.recall(cue, at, true);
      await this.emit(at, {
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
  // Living

  private async live(target: number): Promise<void> {
    while (true) {
      const point = this.nextPoint();
      if (point > target) break;
      const previous = this.cursor;
      this.cursor = point;
      try {
        await this.step(point);
      } catch (error: unknown) {
        // Every part of a step checks the state before acting, so the same point can be
        // retried; moving past it instead would make her wake late or end things late.
        this.cursor = Math.max(previous, this.current.at);
        throw error;
      }
    }
    this.cursor = Math.max(this.cursor, target);
  }

  /** Real time only: if the host was off too long, she does not pretend to have lived it. */
  private async catchUp(now: number): Promise<void> {
    if (now - this.cursor > this.maxCatchUpMs) {
      // emit() moves the cursor only once the lapse is safely written.
      await this.emit(now, { kind: "lapsed", payload: { from: this.cursor, to: now } });
    }
    await this.live(now);
  }

  /** The next moment something has to be decided, strictly after the cursor. */
  private nextPoint(): number {
    const state = this.current;
    const timezone = state.genome.timezone;
    const after = this.cursor;
    if (state.asleep) {
      return nextTopOfHour(after);
    }
    const candidates = WEATHER_HOURS.map((hour) => nextLocalHour(after, hour, timezone));
    // Awake with nothing to do only happens after a conversation woke no activity; decide soon.
    candidates.push(state.activity ? Math.max(state.activity.endsAt, after + 1) : after + MINUTE);
    return Math.min(...candidates);
  }

  private async step(at: number): Promise<void> {
    if (this.current.asleep) {
      if (!this.shouldWake(at)) return;
      await this.wake(at);
    }
    await this.noticeWeather(at);
    const activity = this.current.activity;
    if (activity && activity.endsAt <= at) {
      await this.finishActivity(at);
    }
    if (!this.current.activity && !this.current.asleep) {
      const now = advance(this.current, at);
      const hour = localTime(at, now.genome.timezone).hour;
      const { wakeHour, sleepHour } = now.genome.chronotype;
      const talking = at - lastHeardAt(now) < CONVERSATION_MS;
      if (!isWakingHour(hour, wakeHour, sleepHour)) {
        if (talking) return;
        await this.goToSleep(at, now.sinceKind === "called" ? "没人说话了，又睡了回去" : "到了该睡的时候", true);
      } else if (now.energy < EXHAUSTED_ENERGY) {
        await this.goToSleep(at, "累得睡着了", false);
      } else {
        await this.startActivity(at);
      }
    }
  }

  private shouldWake(at: number): boolean {
    const state = advance(this.current, at);
    const hour = localTime(at, state.genome.timezone).hour;
    const { wakeHour, sleepHour } = state.genome.chronotype;
    if (!isWakingHour(hour, wakeHour, sleepHour)) return false;
    // After a night's sleep she wakes once rested; a nap, a birth or a lapse ends at the first
    // waking hour; nobody sleeps past ten hours.
    return state.sinceKind !== "slept" || state.energy >= 0.55 || at - state.since >= 10 * HOUR;
  }

  private async wake(at: number): Promise<void> {
    const state = advance(this.current, at);
    const reason =
      state.sinceKind === "born" ? "第一次醒来" : state.energy >= 0.95 ? "睡够了，自然醒了" : "醒了过来";
    await this.emit(at, { kind: "woke", causes: [state.sinceId], payload: { reason } });
    // Answer what was said while she slept: the newest message of each person.
    const pending = new Map<string, string>();
    for (const item of this.current.pending) pending.set(item.personId, item.id);
    for (const heardId of pending.values()) {
      const heard = this.log.find((event) => event.id === heardId);
      if (heard?.kind !== "heard") continue;
      await this.feelTalk(at, heard);
      await this.reply(at, heard);
    }
  }

  /** She notices the sky whenever it is different from the last time she looked. */
  private async noticeWeather(at: number): Promise<void> {
    const state = this.current;
    const kind = this.world.weather(at, state.genome.timezone);
    if (kind === state.weather) return;
    const now = advance(state, at);
    const valence = round(this.world.pleasantness(kind) + affinity(now, `weather:${kind}`) * 0.05);
    const perceived = await this.emit(at, {
      kind: "perceived",
      payload: { what: describeWeather(kind), source: "weather", detail: kind, valence, novelty: 0.3 },
    });
    const reason =
      valence > 0.03
        ? `${describeWeather(kind)}，心情跟着好了一点`
        : valence < -0.03
          ? `${describeWeather(kind)}，有点闷`
          : describeWeather(kind);
    await this.emit(at, {
      kind: "felt",
      causes: [perceived.id],
      payload: { valence, arousal: 0.02, reason, about: `weather:${kind}` },
    });
    await this.learn(at, `weather:${kind}`);
  }

  private async startActivity(at: number): Promise<void> {
    const state = advance(this.current, at);
    const random = seededRandom(`${state.genome.seed}:choose:${at}`);
    const context: ActivityContext = { state, world: this.world, random, now: at };
    let best: { kind: ActivityKind; score: number } | undefined;
    for (const kind of this.kinds.values()) {
      const utility = kind.utility(context);
      if (utility === undefined) continue;
      // A little chance, and a little reluctance to do the same small thing twice in a row.
      const repeat = kind.id === state.lastActivity && kind.id !== "read" ? 0.12 : 0;
      const score = utility - repeat + random() * 0.15;
      if (!best || score > best.score) best = { kind, score };
    }
    if (!best) return;
    const plan = best.kind.plan(context);
    const freedBy =
      state.lastEndedId && seqOf(state.lastEndedId) > seqOf(state.sinceId)
        ? state.lastEndedId
        : state.sinceId;
    await this.emit(at, {
      kind: "activity.started",
      causes: [freedBy],
      payload: {
        activity: plan.activity,
        label: plan.label,
        motive: best.kind.motive,
        drives: roundDrives(state.drives),
        endsAt: at + plan.durationMs,
        costPerHour: plan.costPerHour,
        satisfies: plan.satisfies,
        ...(plan.material ? { material: plan.material } : {}),
      },
    });
  }

  private async finishActivity(at: number): Promise<void> {
    const activity = this.current.activity;
    if (!activity) return;
    const ended = await this.emit(at, {
      kind: "activity.ended",
      causes: [activity.startedId],
      payload: {
        activity: activity.activity,
        label: activity.label,
        startedId: activity.startedId,
        satisfied: activity.satisfies,
        interrupted: false,
      },
    });
    const kind = this.kinds.get(activity.activity);
    if (kind) {
      const state = advance(this.current, at);
      const random = seededRandom(`${state.genome.seed}:feel:${at}`);
      const feeling = kind.feel({ state, world: this.world, random, now: at }, activity.material);
      await this.emit(at, {
        kind: "felt",
        causes: [ended.id],
        payload: {
          valence: round(feeling.valence),
          arousal: round(feeling.arousal),
          reason: feeling.reason,
          about: feeling.about,
        },
      });
      await this.learn(at, feeling.about);
      if (feeling.about.includes(":")) await this.learn(at, feeling.about.slice(0, feeling.about.indexOf(":")));
    }
    if (activity.activity === "write") {
      await this.writeNote(at, ended.id);
    }
    await this.feelLonely(at);
  }

  /** Nobody came for a whole day. She feels it once, not every hour. */
  private async feelLonely(at: number): Promise<void> {
    const state = advance(this.current, at);
    if (state.drives.connection < LONELY_THRESHOLD) return;
    const timezone = state.genome.timezone;
    const last = state.tags.lonely;
    if (last !== undefined && dayKey(last, timezone) === dayKey(at, timezone)) return;
    await this.emit(at, {
      kind: "felt",
      causes: [state.sinceId],
      payload: {
        valence: -0.08,
        arousal: 0.02,
        reason: Object.keys(state.people).length > 0 ? "好久没有人来说话了，有点想念" : "一直没有人来说话，有点冷清",
        tag: "lonely",
      },
    });
  }
  private async goToSleep(at: number, reason: string, nightly: boolean): Promise<void> {
    const state = advance(this.current, at);
    const timezone = state.genome.timezone;
    const day = dayKey(state.since, timezone);
    const reflected = this.log.some((event) => event.kind === "reflected" && event.payload.day === day);
    const interrupted = state.sinceKind === "called" && at - state.since < INTERRUPTION_MS;
    if (nightly && !reflected && !interrupted) {
      const facts = gatherFacts(state, this.log, { now: at, focusDay: day, limit: 200 });
      const written = await this.compose(at, { task: "diary", day, facts });
      await this.emit(at, {
        kind: "reflected",
        causes: written.grounds.filter(isEventId),
        payload: { diary: written.text, mind: written.mind, day, ...written.grounding },
      });
    }
    await this.emit(at, { kind: "slept", causes: [state.sinceId], payload: { reason } });
  }

  /** Turns a run of feelings about one thing into a belief about herself, when it is clear. */
  private async learn(at: number, key: string): Promise<void> {
    const state = advance(this.current, at);
    const taste = state.tastes[key];
    if (!taste || taste.count < 3) return;
    const mean = taste.sum / taste.count;
    const beliefKey = `taste:${key}`;
    const existing = state.beliefs[beliefKey];
    // Hysteresis: it takes a clear swing, not one grey afternoon, to change her mind.
    const stance =
      existing?.stance === "like"
        ? mean < 0.02 ? "unsure" : "like"
        : existing?.stance === "dislike"
          ? mean > 0.03 ? "unsure" : "dislike"
          : mean >= 0.06 ? "like" : mean <= -0.02 ? "dislike" : "unsure";
    if (existing ? existing.stance === stance : stance === "unsure") return;
    const names = Object.fromEntries(
      Object.values(state.people).map((person) => [person.personId, person.name ?? "那个人"]),
    );
    const label = tasteLabel(key, this.world, names);
    const statement =
      stance === "like"
        ? `我好像挺喜欢${label}的`
        : stance === "dislike"
          ? `我好像不太喜欢${label}`
          : `我对${label}说不上喜欢不喜欢了`;
    await this.emit(at, {
      kind: "belief",
      causes: [...taste.evidence],
      payload: {
        key: beliefKey,
        stance,
        statement,
        evidence: [...taste.evidence],
        confidence: round(Math.min(0.9, 0.3 + taste.count * 0.08)),
      },
    });
  }

  /** Someone called her out of sleep. The more tired she was, the less she liked it. */
  private async wakeFor(at: number, heard: LifeEvent<"heard">, grumble: boolean): Promise<LifeEvent<"woke">> {
    const state = advance(this.current, at);
    const name = heard.payload.name ?? state.people[heard.payload.personId]?.name ?? "有人";
    const woke = await this.emit(at, {
      kind: "woke",
      causes: [heard.id],
      payload: { reason: `被${name}叫醒了`, by: heard.id },
    });
    if (grumble) {
      const deep = state.energy < 0.5;
      await this.emit(at, {
        kind: "felt",
        causes: [woke.id],
        payload: {
          valence: round(-0.04 - (1 - state.energy) * 0.1),
          arousal: 0.1,
          reason: deep ? "睡得正沉被叫醒，有点起床气" : "被叫醒了，还有点迷糊",
        },
      });
    }
    return woke;
  }

  private emitHeard(at: number, input: HearInput): Promise<LifeEvent<"heard">> {
    return this.emit(at, {
      kind: "heard",
      payload: {
        personId: input.personId,
        ...(input.name ? { name: input.name } : {}),
        text: input.text,
      },
    });
  }

  private crisis(at: number, heard: LifeEvent<"heard">): Promise<LifeEvent<"said">> {
    return this.emit(at, {
      kind: "said",
      causes: [heard.id],
      payload: {
        personId: heard.payload.personId,
        text: this.crisisReply,
        inReplyTo: heard.id,
        mind: SAFETY_MIND_NAME,
        grounds: [],
        rejected: [],
        facts: {},
      },
    });
  }

  private async feelTalk(at: number, heard: LifeEvent<"heard">): Promise<void> {
    const state = advance(this.current, at);
    const personId = heard.payload.personId;
    const name = heard.payload.name ?? state.people[personId]?.name ?? "对方";
    const first = (state.people[personId]?.exchanges ?? 0) <= 1;
    const valence = round(0.08 + affinity(state, `talk:${personId}`) * 0.04);
    await this.emit(at, {
      kind: "felt",
      causes: [heard.id],
      payload: {
        valence,
        arousal: 0.08,
        reason: first ? `第一次有人来和你说话，是${name}` : `${name}来找你说话了`,
        about: `talk:${personId}`,
      },
    });
    await this.learn(at, `talk:${personId}`);
  }

  private async reply(at: number, heard: LifeEvent<"heard">): Promise<LifeEvent<"said">> {
    const state = advance(this.current, at);
    const facts = gatherFacts(state, this.log, {
      now: at,
      personId: heard.payload.personId,
      memory: this.memory,
      cue: heard.payload.text,
    });
    const written = await this.compose(at, {
      task: "reply",
      facts,
      heard: { text: heard.payload.text, name: heard.payload.name },
    });
    return this.emit(at, {
      kind: "said",
      causes: [heard.id, ...written.grounds.filter(isEventId)],
      payload: {
        personId: heard.payload.personId,
        text: written.text,
        inReplyTo: heard.id,
        mind: written.mind,
        ...written.grounding,
      },
    });
  }

  private async writeNote(at: number, endedId: string): Promise<void> {
    const state = advance(this.current, at);
    const facts = gatherFacts(state, this.log, { now: at, lookbackMs: 8 * HOUR, limit: 24 });
    const written = await this.compose(at, { task: "note", facts });
    await this.emit(at, {
      kind: "wrote",
      causes: [endedId, ...written.grounds.filter(isEventId)],
      payload: { text: written.text, mind: written.mind, ...written.grounding },
    });
  }
  // ---------------------------------------------------------------------------------------------
  // Speaking

  /**
   * Asks the mind to put something into words, and checks what it claims to rest on. If the
   * mind is over budget or fails, the inner mind speaks instead and the limit is recorded:
   * she may become plainer, but she never stops and never makes things up.
   */
  private async compose(
    at: number,
    request: Omit<MindRequest, "name" | "voice">,
  ): Promise<{ text: string; mind: string; grounds: string[]; grounding: Grounding }> {
    const state = advance(this.current, at);
    const full: MindRequest = { ...request, name: state.genome.name, voice: state.genome.voice };
    let mind = this.mind;
    if (!FREE_MINDS.has(mind.name)) {
      const today = dayKey(at, state.genome.timezone);
      const used = state.mindDay === today ? state.mindCallsToday : 0;
      if (used >= this.mindCallsPerDay) {
        await this.limit(at, request.task, `今天已经用了 ${used} 次 ${mind.name}，换成内在的声音`, "mind-budget");
        mind = this.inner;
      }
    }
    let response;
    try {
      response = await mind.compose(full);
      if (!response.text.trim()) throw new Error("the mind returned nothing");
    } catch (error: unknown) {
      if (mind === this.inner) throw error;
      this.logger.warn(`mind ${mind.name} failed; the inner mind speaks instead`, error);
      await this.limit(at, request.task, `${mind.name} 出错了：${errorText(error)}`);
      mind = this.inner;
      response = await mind.compose(full);
    }
    const grounding = checkGrounds(request.facts, response.grounds);
    return { text: response.text.trim(), mind: mind.name, grounds: grounding.grounds, grounding };
  }

  private async limit(at: number, what: string, reason: string, tag?: string): Promise<void> {
    const state = this.current;
    if (tag) {
      const last = state.tags[tag];
      const timezone = state.genome.timezone;
      if (last !== undefined && dayKey(last, timezone) === dayKey(at, timezone)) return;
    }
    await this.emit(at, { kind: "limited", payload: { what, reason, ...(tag ? { tag } : {}) } });
  }

  // ---------------------------------------------------------------------------------------------
  // The log

  private async emit<K extends LifeEventKind>(
    at: number,
    draft: { kind: K; payload: LifeEventPayloads[K]; causes?: string[] },
  ): Promise<LifeEvent<K>> {
    const [event] = await this.commit(at, [draft as Draft]);
    return event as LifeEvent<K>;
  }

  /** Writes events to the archive first, then folds them in. A failed write changes nothing. */
  private async commit(at: number, drafts: Draft[]): Promise<LifeEvent[]> {
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
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** Keeps the ids that were offered and records the ones that were not. */
function checkGrounds(offered: Fact[], cited: string[]): Grounding {
  const texts = new Map(offered.map((fact) => [fact.id, fact.text]));
  const unique = [...new Set(cited)];
  const grounds = unique.filter((id) => texts.has(id));
  const rejected = unique.filter((id) => !texts.has(id));
  const facts = Object.fromEntries(grounds.map((id) => [id, texts.get(id) ?? ""]));
  return { grounds, rejected, facts };
}

function lastHeardAt(state: LifeState): number {
  return Math.max(-Infinity, ...Object.values(state.people).map((person) => person.lastHeardAt));
}

function isEventId(id: string): boolean {
  return /^e\d+$/u.test(id);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown error";
}

function nextTopOfHour(after: number): number {
  return (Math.floor(after / HOUR) + 1) * HOUR;
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
