import { localTime } from "@isla/core";
import { affinity, tasteLabel, type ActivityContext, type ActivityKind } from "./activities.js";
import { DAY, HOUR, MINUTE, isWakingHour, localDayRange, nextLocalHour } from "./clock.js";
import { chaptersOf, episodesOf, type ConsolidationContext } from "./consolidate.js";
import type { LifeEvent, Material } from "./events.js";
import { gatherFacts } from "./facts.js";
import {
  checkGrounds,
  findLast,
  isEventId,
  lastHeardAt,
  nextTopOfHour,
  round,
  roundDrives,
  seqOf,
  type LifeInternals,
} from "./internal.js";
import type { GoalCandidate } from "./mind.js";
import { seededRandom } from "./random.js";
import { advance, BONDS, dayKey, type Bond, type LifeState } from "./state.js";
import { compose, reply, writeNote } from "./speech.js";
import { describeWeather } from "./world.js";

/** What it takes to know someone one step better. */
const BOND_STEPS: Array<{ bond: Bond; talkDays: number; exchanges: number; days: number; warmth: number }> = [
  { bond: "familiar", talkDays: 4, exchanges: 30, days: 3, warmth: 0 },
  { bond: "close", talkDays: 14, exchanges: 150, days: 14, warmth: 0.06 },
  { bond: "trusted", talkDays: 40, exchanges: 500, days: 60, warmth: 0.08 },
];

/** A message she sends only if they have been quiet at least this long. */
const URGE_QUIET_MS = 2 * HOUR;
/** How much she must have liked something to want to share it. */
const SHARE_VALENCE = 0.08;
/** How much she must want company to say so. */
const MISS_CONNECTION = 0.7;
/** After being woken, she stays up while someone keeps talking to her. */
const CONVERSATION_MS = 20 * MINUTE;
/** Woken in the night and back asleep within this long: it was an interruption, not a day. */
const INTERRUPTION_MS = 3 * HOUR;
const LONELY_THRESHOLD = 0.85;
const EXHAUSTED_ENERGY = 0.1;
const WEATHER_HOURS = [0, 6, 12, 18];

/** A perception from outside moves her at most this much before her own affinity and habituation. */
const MAX_PERCEIVED_VALENCE = 0.15;
/** The same thing again within this window is less new each time. */
const HABITUATION_MS = 24 * HOUR;
/** The world she lives in reports under these; a host cannot pretend to be it. */
const FORBIDDEN_SOURCES = new Set(["weather"]);

export interface PerceiveInput {
  /** Where it came from, e.g. `machine`, `calendar`, `rss`. One word; feelings about it are kept per source. */
  source: string;
  /** What she noticed, as she would say it: "主人的电脑开始播放音乐". */
  what: string;
  /**
   * What it is, for learning what she likes, e.g. `music` or `news:tech`. Without it she still
   * notices, but does not form a taste.
   */
  detail?: string;
  /** How the host rates it, -1 to 1. She is moved by it only a little; her temperament decides the rest. */
  valence?: number;
}

export async function live(life: LifeInternals, target: number): Promise<void> {
  while (true) {
    const point = nextPoint(life);
    if (point > target) break;
    const previous = life.cursor;
    life.cursor = point;
    try {
      await step(life, point);
    } catch (error: unknown) {
      // Every part of a step checks the state before acting, so the same point can be
      // retried; moving past it instead would make her wake late or end things late.
      life.cursor = Math.max(previous, life.current.at);
      throw error;
    }
  }
  life.cursor = Math.max(life.cursor, target);
}

/** Real time only: if the host was off too long, she does not pretend to have lived it. */
export async function catchUp(life: LifeInternals, now: number): Promise<void> {
  if (now - life.cursor > life.maxCatchUpMs) {
    // emit() moves the cursor only once the lapse is safely written.
    await life.emit(now, { kind: "lapsed", payload: { from: life.cursor, to: now } });
  }
  await live(life, now);
}

/** The next moment something has to be decided, strictly after the cursor. */
export function nextPoint(life: LifeInternals): number {
  const state = life.current;
  const timezone = state.genome.timezone;
  const after = life.cursor;
  if (state.asleep) {
    return nextTopOfHour(after);
  }
  const candidates = WEATHER_HOURS.map((hour) => nextLocalHour(after, hour, timezone));
  // Awake with nothing to do only happens after a conversation woke no activity; decide soon.
  candidates.push(state.activity ? Math.max(state.activity.endsAt, after + 1) : after + MINUTE);
  return Math.min(...candidates);
}

export async function step(life: LifeInternals, at: number): Promise<void> {
  if (life.current.asleep) {
    if (!shouldWake(life, at)) return;
    await wake(life, at);
  }
  await noticeWeather(life, at);
  const activity = life.current.activity;
  if (activity && activity.endsAt <= at) {
    await finishActivity(life, at);
  }
  if (!life.current.activity && !life.current.asleep) {
    const now = advance(life.current, at);
    const hour = localTime(at, now.genome.timezone).hour;
    const { wakeHour, sleepHour } = now.genome.chronotype;
    const talking = at - lastHeardAt(now) < CONVERSATION_MS;
    if (!isWakingHour(hour, wakeHour, sleepHour)) {
      if (talking) return;
      await goToSleep(life, at, now.sinceKind === "called" ? "没人说话了，又睡了回去" : "到了该睡的时候", true);
    } else if (now.energy < EXHAUSTED_ENERGY) {
      await goToSleep(life, at, "累得睡着了", false);
    } else {
      await startActivity(life, at);
    }
  }
}

function shouldWake(life: LifeInternals, at: number): boolean {
  const state = advance(life.current, at);
  const hour = localTime(at, state.genome.timezone).hour;
  const { wakeHour, sleepHour } = state.genome.chronotype;
  if (!isWakingHour(hour, wakeHour, sleepHour)) return false;
  // After a night's sleep she wakes once rested; a nap, a birth or a lapse ends at the first
  // waking hour; nobody sleeps past ten hours.
  return state.sinceKind !== "slept" || state.energy >= 0.55 || at - state.since >= 10 * HOUR;
}

async function wake(life: LifeInternals, at: number): Promise<void> {
  const state = advance(life.current, at);
  const reason =
    state.sinceKind === "born" ? "第一次醒来" : state.energy >= 0.95 ? "睡够了，自然醒了" : "醒了过来";
  await life.emit(at, { kind: "woke", causes: [state.sinceId], payload: { reason } });
  // Answer what was said while she slept: the newest message of each person.
  const pending = new Map<string, string>();
  for (const item of life.current.pending) pending.set(item.personId, item.id);
  for (const heardId of pending.values()) {
    const heard = life.log.find((event) => event.id === heardId);
    if (heard?.kind !== "heard") continue;
    await feelTalk(life, at, heard);
    await reply(life, at, heard);
  }
}

/** She notices the sky whenever it is different from the last time she looked. */
async function noticeWeather(life: LifeInternals, at: number): Promise<void> {
  // A real sky is reported by the host; she does not make one up.
  if (life.world.sky === "host") return;
  const state = life.current;
  const kind = life.world.weather(at, state.genome.timezone);
  if (kind === state.weather) return;
  await seeSky(life, at, kind, describeWeather(kind));
}

/** The sky changed and she noticed: a perception, a feeling, perhaps a taste. */
async function seeSky(life: LifeInternals, at: number, kind: string, what: string): Promise<LifeEvent<"perceived">> {
  const now = advance(life.current, at);
  const valence = round(life.world.pleasantness(kind) + affinity(now, `weather:${kind}`) * 0.05);
  const perceived = await life.emit(at, {
    kind: "perceived",
    payload: { what, source: "weather", detail: kind, valence, novelty: 0.3 },
  });
  const reason = valence > 0.03 ? `${what}，心情跟着好了一点` : valence < -0.03 ? `${what}，有点闷` : what;
  await life.emit(at, {
    kind: "felt",
    causes: [perceived.id],
    payload: { valence, arousal: 0.02, reason, about: `weather:${kind}` },
  });
  await learn(life, at, `weather:${kind}`);
  return perceived;
}

async function startActivity(life: LifeInternals, at: number): Promise<void> {
  const state = advance(life.current, at);
  const random = seededRandom(`${state.genome.seed}:choose:${at}`);
  const context: ActivityContext = { state, world: life.world, random, now: at };
  let best: { kind: ActivityKind; score: number } | undefined;
  for (const kind of life.kinds.values()) {
    const utility = kind.utility(context);
    if (utility === undefined) continue;
    // A little chance, and a little reluctance to do the same small thing twice in a row.
    const repeat = kind.id === state.lastActivity && kind.id !== "read" ? 0.12 : 0;
    const score = utility - repeat + random() * 0.15 + (kind.id === "read" ? goalPull(state) : 0);
    if (!best || score > best.score) best = { kind, score };
  }
  if (!best) return;
  const plan = best.kind.plan(context);
  const freedBy =
    state.lastEndedId && seqOf(state.lastEndedId) > seqOf(state.sinceId)
      ? state.lastEndedId
      : state.sinceId;
  await life.emit(at, {
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

async function finishActivity(life: LifeInternals, at: number): Promise<void> {
  const activity = life.current.activity;
  if (!activity) return;
  const ended = await life.emit(at, {
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
  const kind = life.kinds.get(activity.activity);
  if (kind) {
    const state = advance(life.current, at);
    const random = seededRandom(`${state.genome.seed}:feel:${at}`);
    const feeling = kind.feel({ state, world: life.world, random, now: at }, activity.material);
    await life.emit(at, {
      kind: "felt",
      causes: [ended.id],
      payload: {
        valence: round(feeling.valence),
        arousal: round(feeling.arousal),
        reason: feeling.reason,
        about: feeling.about,
      },
    });
    await learn(life, at, feeling.about);
    if (feeling.about.includes(":")) await learn(life, at, feeling.about.slice(0, feeling.about.indexOf(":")));
  }
  if (activity.activity === "write") {
    const wrote = await writeNote(life, at, ended.id);
    await advanceMake(life, at, wrote);
  }
  if (activity.activity === "read" && activity.material?.kind === "passage") {
    await advanceGoal(life, at, ended.id, activity.material.bookId);
  }
  await feelLonely(life, at);
  if (life.reachOut) await feelUrge(life, at, ended.id, activity.material);
}

/** A little extra pull toward the activity that would move a goal forward. */
function goalPull(state: LifeState): number {
  const active = Object.values(state.goals).filter((goal) => goal.status === "active" && goal.kind === "finish");
  if (active.length === 0) return 0;
  return 0.25 * Math.max(...active.map((goal) => goal.need));
}

/** A passage was read: move the matching goal forward, and finish it when the book is done. */
async function advanceGoal(life: LifeInternals, at: number, endedId: string, bookId: string): Promise<void> {
  const goal = Object.values(advance(life.current, at).goals).find(
    (item) => item.status === "active" && item.kind === "finish" && item.about === `read:${bookId}`,
  );
  if (!goal) return;
  const progressed = await life.emit(at, {
    kind: "progressed",
    causes: [endedId],
    payload: { goalId: goal.goalId, by: endedId, amount: 1 },
  });
  const state = advance(life.current, at);
  const book = life.world.books.find((item) => item.id === bookId);
  if (!book || (state.reading[bookId] ?? 0) < book.passages.length) return;
  await life.emit(at, {
    kind: "achieved",
    causes: [progressed.id],
    payload: { goalId: goal.goalId },
  });
  await life.emit(at, {
    kind: "felt",
    causes: [progressed.id],
    payload: {
      valence: 0.12,
      arousal: 0.06,
      reason: `终于把《${book.title}》读完了`,
      about: "goal:finish",
    },
  });
  await learn(life, at, "goal:finish");
}

/** A note about the same thing: move the make goal forward, and finish the piece at three. */
export async function advanceMake(
  life: LifeInternals,
  at: number,
  wrote: LifeEvent<"wrote">,
): Promise<void> {
  const about = wrote.payload.about;
  if (!about) return;
  const goal = Object.values(advance(life.current, at).goals).find(
    (item) => item.status === "active" && item.kind === "make" && item.about === about,
  );
  if (!goal) return;
  const progressed = await life.emit(at, {
    kind: "progressed",
    causes: [wrote.id],
    payload: { goalId: goal.goalId, by: wrote.id, amount: 1 },
  });
  if (goal.progress + 1 < 3) return;
  const notes = life.log
    .filter((event): event is LifeEvent<"wrote"> => event.kind === "wrote" && event.payload.about === about)
    .slice(-3);
  if (notes.length < 3) return;
  await life.emit(at, {
    kind: "made",
    causes: [progressed.id, ...notes.map((event) => event.id)],
    payload: {
      title: goal.statement,
      text: notes.map((event) => event.payload.text).join("\n"),
      about,
      mind: "inner",
      grounds: notes.map((event) => event.id),
      rejected: [],
      facts: {},
    },
  });
  await life.emit(at, { kind: "achieved", causes: [progressed.id], payload: { goalId: goal.goalId } });
  await life.emit(at, {
    kind: "felt",
    causes: [progressed.id],
    payload: { valence: 0.12, arousal: 0.06, reason: "把想写的东西写完了", about: "goal:make" },
  });
  await learn(life, at, "goal:make");
}

/** A promise was closed: the goal it belongs to is done. */
export async function advanceDoFor(
  life: LifeInternals,
  at: number,
  noted: LifeEvent<"noted">,
): Promise<void> {
  if (!noted.payload.done) return;
  const about = `person:${noted.payload.personId}:${noted.payload.topic}`;
  const goal = Object.values(advance(life.current, at).goals).find(
    (item) => item.status === "active" && item.about === about,
  );
  if (!goal) return;
  const progressed = await life.emit(at, {
    kind: "progressed",
    causes: [noted.id],
    payload: { goalId: goal.goalId, by: noted.id, amount: 1 },
  });
  await life.emit(at, {
    kind: "achieved",
    causes: [progressed.id],
    payload: { goalId: goal.goalId },
  });
  await life.emit(at, {
    kind: "felt",
    causes: [progressed.id],
    payload: {
      valence: 0.1,
      arousal: 0.04,
      reason: `把答应的事办完了：${goal.statement}`,
      about: "goal:do-for",
    },
  });
  await learn(life, at, "goal:do-for");
}

/**
 * Before sleep she may take on something for the next days. The kernel offers what is actually
 * open; the mind picks one and says why; the kernel accepts only a choice that rests on a fact
 * it was given.
 */
async function deliberate(life: LifeInternals, at: number): Promise<void> {
  const state = advance(life.current, at);
  const active = Object.values(state.goals).filter((goal) => goal.status === "active");
  if (active.length >= 3) return;
  const candidates: GoalCandidate[] = [];
  // A promise comes first: something she was told and has not done yet.
  for (const [personId, topics] of Object.entries(state.notes)) {
    for (const note of Object.values(topics)) {
      if (!note.pending) continue;
      const about = `person:${personId}:${note.topic}`;
      if (active.some((goal) => goal.about === about)) continue;
      const name = state.people[personId]?.name ?? "对方";
      candidates.push({
        about,
        kind: "do-for",
        statement: `把答应${name}的事办完：${note.text}`,
        need: 0.6,
        grounds: [note.eventId],
      });
    }
  }
  for (const book of life.world.books) {
    const index = state.reading[book.id] ?? 0;
    if (index >= book.passages.length) continue;
    if (active.some((goal) => goal.about === `read:${book.id}`)) continue;
    const started = findLast(
      life.log,
      (event) =>
        event.kind === "activity.started" &&
        event.payload.material?.kind === "passage" &&
        event.payload.material.bookId === book.id,
    );
    if (!started) continue;
    candidates.push({
      about: `read:${book.id}`,
      kind: "finish",
      statement: `读完《${book.title}》`,
      need: 0.5,
      grounds: [started.id],
    });
  }
  // A book she has finished is something she may want to write about, once.
  for (const book of life.world.books) {
    const index = state.reading[book.id] ?? 0;
    if (index < book.passages.length) continue;
    const about = `read:${book.id}`;
    if (Object.values(state.goals).some((goal) => goal.kind === "make" && goal.about === about)) continue;
    const started = findLast(
      life.log,
      (event) =>
        event.kind === "activity.started" &&
        event.payload.material?.kind === "passage" &&
        event.payload.material.bookId === book.id,
    );
    if (!started) continue;
    candidates.push({
      about,
      kind: "make",
      statement: `写一篇关于《${book.title}》的东西`,
      need: 0.5,
      grounds: [started.id],
    });
  }
  if (candidates.length === 0) return;
  const facts = gatherFacts(state, life.log, { now: at, lookbackMs: 7 * DAY });
  const response = await compose(life, at, { task: "deliberate", facts, candidates });
  const selected = candidates.find((candidate) => candidate.about === response.choice);
  if (!selected) return;
  const grounding = checkGrounds(facts, selected.grounds);
  await life.emit(at, {
    kind: "aimed",
    causes: selected.grounds.filter(isEventId),
    payload: {
      goalId: `${selected.about}@${dayKey(at, state.genome.timezone)}`,
      kind: selected.kind,
      about: selected.about,
      statement: selected.statement,
      need: selected.need,
      mind: response.mind,
      ...grounding,
    },
  });
}

/** A week without progress: she lets it go, and it is felt, not hidden. */
async function dropStale(life: LifeInternals, at: number): Promise<void> {
  const state = advance(life.current, at);
  for (const goal of Object.values(state.goals)) {
    if (goal.status !== "active") continue;
    if (at - goal.aimedAt < 7 * DAY || at - goal.lastProgressAt < 7 * DAY) continue;
    await life.emit(at, {
      kind: "dropped",
      causes: [goal.aimId, ...(goal.lastProgressId ? [goal.lastProgressId] : [])],
      payload: { goalId: goal.goalId, reason: "一个星期没有进展了" },
    });
    await life.emit(at, {
      kind: "felt",
      causes: [goal.aimId],
      payload: {
        valence: -0.04,
        arousal: 0.02,
        reason: `关于「${goal.statement}」，好像就这么放下了`,
        about: "goal:finish",
      },
    });
    await learn(life, at, "goal:finish");
  }
}

/**
 * After something she did, does she want to tell someone? Only for a reason in her life: she
 * misses them, she came across something they would care about, or she still owes them
 * something. Never while they are talking to her, never twice in a row before they answer, and
 * the same reason not again for a while; there is no quota beyond that.
 */
async function feelUrge(
  life: LifeInternals,
  at: number,
  endedId: string,
  material: Material | undefined,
): Promise<void> {
  const state = advance(life.current, at);
  if (state.asleep) return;
  for (const personId of life.reachOut?.personIds ?? []) {
    const person = state.people[personId];
    if (!person) continue;
    const lastHeard = person.lastHeardAt;
    if (at - lastHeard < URGE_QUIET_MS) continue;
    // The last urge has not been answered yet: wait for them, do not pile on.
    const lastUrge = findLast(life.log, (event) => event.kind === "urged" && event.payload.personId === personId, 3000);
    if (lastUrge && lastUrge.at > lastHeard) continue;
    const urge = urgeFor(life, state, personId, material);
    if (!urge) continue;
    await life.emit(at, {
      kind: "urged",
      causes: [endedId, ...urge.causes],
      payload: { personId, why: urge.why, about: urge.about },
    });
    return;
  }
}

function urgeFor(
  life: LifeInternals,
  state: LifeState,
  personId: string,
  material: Material | undefined,
): { why: "missed" | "share" | "pending"; about: string; causes: string[] } | undefined {
  const name = state.people[personId]?.name ?? "对方";
  // Something still to do for them comes first: a butler does not sit on a promise.
  const open = Object.values(state.notes[personId] ?? {}).filter((note) => note.pending);
  if (open.length > 0 && !urgedRecently(life, personId, "pending", state.at, DAY)) {
    const oldest = open.sort((left, right) => left.at - right.at)[0]!;
    return { why: "pending", about: oldest.text, causes: [oldest.eventId] };
  }
  // Something she just came across that she liked a lot, about a thing they care about.
  if (material?.kind === "item" && !urgedRecently(life, personId, "share", state.at, 6 * HOUR)) {
    const felt = findLast(life.log, (event) => event.kind === "felt", 4);
    if (felt?.kind === "felt" && felt.payload.valence >= SHARE_VALENCE) {
      const notes = Object.values(state.notes[personId] ?? {});
      const cares = material.tags.some((tag) => notes.some((note) => note.text.includes(tag) || note.topic.includes(tag)));
      if (cares || felt.payload.valence >= SHARE_VALENCE * 1.5) {
        return { why: "share", about: `${material.title}（${material.tags.join("、") || material.shelf}）`, causes: [material.stockedId] };
      }
    }
  }
  // She has not heard from them in a long while, and she wants to.
  if (state.drives.connection >= MISS_CONNECTION && !urgedRecently(life, personId, "missed", state.at, DAY)) {
    return { why: "missed", about: `好久没和${name}说话了`, causes: [] };
  }
  return undefined;
}

function urgedRecently(life: LifeInternals, personId: string, why: string, at: number, within: number): boolean {
  for (let index = life.log.length - 1; index >= 0; index--) {
    const event = life.log[index]!;
    if (event.at < at - within) return false;
    if (event.kind === "urged" && event.payload.personId === personId && event.payload.why === why) return true;
  }
  return false;
}

/** Nobody came for a whole day. She feels it once, not every hour. */
async function feelLonely(life: LifeInternals, at: number): Promise<void> {
  const state = advance(life.current, at);
  if (state.drives.connection < LONELY_THRESHOLD) return;
  const timezone = state.genome.timezone;
  const last = state.tags.lonely;
  if (last !== undefined && dayKey(last, timezone) === dayKey(at, timezone)) return;
  await life.emit(at, {
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

async function goToSleep(life: LifeInternals, at: number, reason: string, nightly: boolean): Promise<void> {
  const state = advance(life.current, at);
  const timezone = state.genome.timezone;
  const day = dayKey(state.since, timezone);
  const reflected = life.log.some((event) => event.kind === "reflected" && event.payload.day === day);
  const interrupted = state.sinceKind === "called" && at - state.since < INTERRUPTION_MS;
  if (nightly && !reflected && !interrupted) {
    const facts = gatherFacts(state, life.log, { now: at, focusDay: day, limit: 200 });
    const written = await compose(life, at, { task: "diary", day, facts });
    await life.emit(at, {
      kind: "reflected",
      causes: written.grounds.filter(isEventId),
      payload: { diary: written.text, mind: written.mind, day, ...written.grounding },
    });
  }
  if (nightly && !interrupted) {
    await deliberate(life, at);
    await dropStale(life, at);
  }
  if (nightly && !interrupted) await consolidate(life, at, day);
  await life.emit(at, { kind: "slept", causes: [state.sinceId], payload: { reason } });
}

/**
 * Before sleep: the day since the last episode becomes episodes, and a week or a month that
 * ends today becomes a chapter. Each is written once, so a retried night does not repeat it.
 */
async function consolidate(life: LifeInternals, at: number, day: string): Promise<void> {
  const timezone = life.current.genome.timezone;
  const context: ConsolidationContext = {
    timezone,
    strength: (id) => life.memory.strength(id, at) ?? -Infinity,
    names: (personId) => life.current.people[personId]?.name ?? "对方",
  };
  let lastEnd = -Infinity;
  let done = false;
  for (let index = life.log.length - 1; index >= 0; index--) {
    const event = life.log[index]!;
    if (event.kind !== "episode") continue;
    lastEnd = event.payload.to;
    done = event.payload.day === day;
    break;
  }
  if (!done) {
    const from = Math.max(lastEnd, localDayRange(day, timezone).from);
    const episodes = episodesOf(life.log, day, from, at, context);
    if (episodes.length > 0) await life.commit(at, episodes);
  }
  const written = new Set(
    life.log
      .slice(-400)
      .filter((event): event is LifeEvent<"chapter"> => event.kind === "chapter")
      .map((event) => `${event.payload.span}:${event.payload.label}`),
  );
  const chapters = chaptersOf(life.log, day, context).filter(
    (draft) => !written.has(`${draft.payload.span}:${draft.payload.label}`),
  );
  if (chapters.length > 0) await life.commit(at, chapters);
}

/** Turns a run of feelings about one thing into a belief about herself, when it is clear. */
async function learn(life: LifeInternals, at: number, key: string): Promise<void> {
  const state = advance(life.current, at);
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
  const labels = Object.fromEntries(
    [...life.kinds.values()].flatMap((kind) => (kind.label ? [[kind.id, kind.label]] : [])),
  );
  const label = tasteLabel(key, life.world, names, labels);
  const statement =
    stance === "like"
      ? `我好像挺喜欢${label}的`
      : stance === "dislike"
        ? `我好像不太喜欢${label}`
        : `我对${label}说不上喜欢不喜欢了`;
  await life.emit(at, {
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
export async function wakeFor(
  life: LifeInternals,
  at: number,
  heard: LifeEvent<"heard">,
  grumble: boolean,
): Promise<LifeEvent<"woke">> {
  const state = advance(life.current, at);
  const name = heard.payload.name ?? state.people[heard.payload.personId]?.name ?? "有人";
  const woke = await life.emit(at, {
    kind: "woke",
    causes: [heard.id],
    payload: { reason: `被${name}叫醒了`, by: heard.id },
  });
  if (grumble) {
    const deep = state.energy < 0.5;
    await life.emit(at, {
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

export async function feelTalk(life: LifeInternals, at: number, heard: LifeEvent<"heard">): Promise<void> {
  const state = advance(life.current, at);
  const personId = heard.payload.personId;
  const name = heard.payload.name ?? state.people[personId]?.name ?? "对方";
  const first = (state.people[personId]?.exchanges ?? 0) <= 1;
  const valence = round(0.08 + affinity(state, `talk:${personId}`) * 0.04);
  await life.emit(at, {
    kind: "felt",
    causes: [heard.id],
    payload: {
      valence,
      arousal: 0.08,
      reason: first ? `第一次有人来和你说话，是${name}` : `${name}来找你说话了`,
      about: `talk:${personId}`,
    },
  });
  await learn(life, at, `talk:${personId}`);
  await deepen(life, at, personId);
}

/**
 * Whether she now knows them well enough for the next step. Time alone is not enough, and
 * neither is talk alone: it takes days spent talking and having liked it.
 */
async function deepen(life: LifeInternals, at: number, personId: string): Promise<void> {
  const state = advance(life.current, at);
  const person = state.people[personId];
  if (!person) return;
  const taste = state.tastes[`talk:${personId}`];
  const warmth = taste && taste.count > 0 ? taste.sum / taste.count : 0;
  const known = Math.floor((at - person.firstHeardAt) / DAY);
  const reached = BOND_STEPS.filter(
    (step) => person.talkDays >= step.talkDays && person.exchanges >= step.exchanges && known >= step.days && warmth >= step.warmth,
  ).at(-1)?.bond ?? "stranger";
  if (BONDS.indexOf(reached) <= BONDS.indexOf(person.bond)) return;
  await life.emit(at, {
    kind: "bonded",
    causes: [...(taste?.evidence ?? [])],
    payload: { personId, bond: reached, because: `认识 ${known} 天了，聊过 ${person.talkDays} 天、${person.exchanges} 句` },
  });
}

export async function perceive(life: LifeInternals, input: PerceiveInput): Promise<LifeEvent<"perceived"> | undefined> {
  const source = input.source.trim();
  const what = input.what.trim();
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(source)) throw new Error("perceive() needs a one-word source");
  if (!what || what.length > 200) throw new Error("perceive() needs a short description");
  const hostSky = life.world.sky === "host" && source === "weather";
  if (FORBIDDEN_SOURCES.has(source) && !hostSky) {
    throw new Error(`"${source}" is a source the kernel keeps for itself`);
  }
  return life.serial(async () => {
    const at = Math.max(life.clock(), life.cursor);
    await life.catchUp(at);
    if (life.current.asleep) return undefined;
    if (hostSky) {
      const kind = input.detail?.trim();
      if (!kind) throw new Error('the sky needs its kind in `detail`, e.g. "小雨"');
      // The same sky again is not news; she only looks up when it changes.
      if (kind === life.current.weather) return undefined;
      return seeSky(life, at, kind, what);
    }
    const state = advance(life.current, at);
    const key = input.detail ? `${source}:${input.detail.trim()}` : source;
    let seen = 0;
    for (let index = life.log.length - 1; index >= 0; index--) {
      const event = life.log[index]!;
      if (event.at < at - HABITUATION_MS) break;
      if (event.kind === "perceived" && event.payload.source === source && event.payload.detail === input.detail) seen++;
    }
    const novelty = round(1 / (1 + seen));
    const hosted = Math.max(-1, Math.min(1, input.valence ?? 0)) * MAX_PERCEIVED_VALENCE;
    const valence = round((hosted + affinity(state, key) * 0.05) * novelty);
    const perceived = await life.emit(at, {
      kind: "perceived",
      payload: { what, source, ...(input.detail ? { detail: input.detail.trim() } : {}), valence, novelty },
    });
    if (Math.abs(valence) >= 0.02) {
      const about = input.detail ? key : undefined;
      await life.emit(at, {
        kind: "felt",
        causes: [perceived.id],
        payload: {
          valence,
          arousal: round(0.05 * novelty),
          reason: valence > 0 ? `${what}，有点高兴` : `${what}，有点烦`,
          ...(about ? { about } : {}),
        },
      });
      if (about) await learn(life, at, about);
    }
    return perceived;
  });
}
