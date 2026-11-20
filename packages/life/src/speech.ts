import { advance, dayKey } from "./state.js";
import type { Grounding, LifeEvent } from "./events.js";
import { FREE_MINDS } from "./events.js";
import { gatherFacts } from "./facts.js";
import { checkGrounds, errorText, findLast, isEventId, type LifeInternals } from "./internal.js";
import type { MindRequest } from "./mind.js";

export interface Composed {
  text: string;
  mind: string;
  grounds: string[];
  grounding: Grounding;
  /** For `deliberate`: which candidate the mind chose. */
  choice?: string | undefined;
}

export interface HeardInput {
  personId: string;
  name?: string;
  text: string;
  /** Where the host keeps the whole conversation, e.g. `dsh-session:<id>`. */
  where?: string;
}

export function emitHeard(life: LifeInternals, at: number, input: HeardInput): Promise<LifeEvent<"heard">> {
  return life.emit(at, {
    kind: "heard",
    payload: {
      personId: input.personId,
      ...(input.name ? { name: input.name } : {}),
      text: input.text,
      ...(input.where ? { where: input.where } : {}),
    },
  });
}

/** The fixed reply to someone in danger, whatever mind she has and whether or not she is asleep. */
export function crisis(life: LifeInternals, at: number, heard: LifeEvent<"heard">): Promise<LifeEvent<"said">> {
  return life.emit(at, {
    kind: "said",
    causes: [heard.id],
    payload: {
      personId: heard.payload.personId,
      text: life.crisisReply,
      inReplyTo: heard.id,
      mind: "safety",
      grounds: [],
      rejected: [],
      facts: {},
    },
  });
}

export async function reply(life: LifeInternals, at: number, heard: LifeEvent<"heard">): Promise<LifeEvent<"said">> {
  const state = advance(life.current, at);
  const facts = gatherFacts(state, life.log, {
    now: at,
    personId: heard.payload.personId,
    memory: life.memory,
    cue: heard.payload.text,
  });
  const written = await compose(life, at, {
    task: "reply",
    facts,
    heard: { text: heard.payload.text, name: heard.payload.name },
  });
  return life.emit(at, {
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

export async function writeNote(life: LifeInternals, at: number, endedId: string): Promise<LifeEvent<"wrote">> {
  const state = advance(life.current, at);
  const facts = gatherFacts(state, life.log, { now: at, lookbackMs: 8 * 60 * 60 * 1000, limit: 24 });
  const written = await compose(life, at, { task: "note", facts });
  // What she was reading when she sat down to write; a `make` goal counts notes about it.
  const reading = findLast(
    life.log,
    (event) =>
      event.kind === "activity.started" && Boolean(event.payload.material) && event.payload.material?.kind !== "view",
    60,
  );
  const material = reading?.kind === "activity.started" ? reading.payload.material : undefined;
  const about =
    material?.kind === "passage"
      ? `read:${material.bookId}`
      : material?.kind === "item"
        ? `item:${material.shelf}:${material.item}`
        : undefined;
  return life.emit(at, {
    kind: "wrote",
    causes: [endedId, ...written.grounds.filter(isEventId)],
    payload: { text: written.text, mind: written.mind, ...(about ? { about } : {}), ...written.grounding },
  });
}

/**
 * Asks the mind to put something into words, and checks what it claims to rest on. If the
 * mind is over budget or fails, the inner mind speaks instead and the limit is recorded:
 * she may become plainer, but she never stops and never makes things up.
 */
export async function compose(
  life: LifeInternals,
  at: number,
  request: Omit<MindRequest, "name" | "voice">,
): Promise<Composed> {
  const state = advance(life.current, at);
  const full: MindRequest = { ...request, name: state.genome.name, voice: state.genome.voice };
  let mind = life.mind;
  if (!FREE_MINDS.has(mind.name)) {
    const today = dayKey(at, state.genome.timezone);
    const used = state.mindDay === today ? state.mindCallsToday : 0;
    if (used >= life.mindCallsPerDay) {
      await limit(life, at, request.task, `今天已经用了 ${used} 次 ${mind.name}，换成内在的声音`, "mind-budget");
      mind = life.inner;
    }
  }
  let response;
  try {
    response = await mind.compose(full);
    if (!response.text.trim()) throw new Error("the mind returned nothing");
  } catch (error: unknown) {
    if (mind === life.inner) throw error;
    life.logger.warn(`mind ${mind.name} failed; the inner mind speaks instead`, error);
    await limit(life, at, request.task, `${mind.name} 出错了：${errorText(error)}`);
    mind = life.inner;
    response = await mind.compose(full);
  }
  const grounding = checkGrounds(request.facts, response.grounds);
  return {
    text: response.text.trim(),
    mind: mind.name,
    grounds: grounding.grounds,
    grounding,
    ...(response.choice ? { choice: response.choice } : {}),
  };
}

export async function limit(
  life: LifeInternals,
  at: number,
  what: string,
  reason: string,
  tag?: string,
): Promise<void> {
  const state = life.current;
  if (tag) {
    const last = state.tags[tag];
    const timezone = state.genome.timezone;
    if (last !== undefined && dayKey(last, timezone) === dayKey(at, timezone)) return;
  }
  await life.emit(at, { kind: "limited", payload: { what, reason, ...(tag ? { tag } : {}) } });
}
