import { z } from "zod";
import { INNER_MIND_NAME, type LifeEvent, type LifeEventKind } from "./events.js";
import type { Fact } from "./facts.js";

export type MindTask = "reply" | "diary" | "note" | "deliberate";

/** One thing she could set out to do, offered to the mind to choose from. */
export interface GoalCandidate {
  about: string;
  kind: "finish" | "make" | "learn" | "do-for";
  statement: string;
  need: number;
  /** Fact ids that make this something she could set out to do. */
  grounds: string[];
}

export interface MindRequest {
  task: MindTask;
  name: string;
  /** How she talks; style only, never a source of facts. */
  voice: string;
  /** The only things she may say about herself. */
  facts: Fact[];
  /** For replies: what was just said to her. */
  heard?: { text: string; name?: string | undefined };
  /** For diaries: the local date she is writing about. */
  day?: string;
  /** For deliberate: the goals she could take on tonight. */
  candidates?: GoalCandidate[];
  signal?: AbortSignal;
}

export interface MindResponse {
  text: string;
  /** Ids of the facts the text rests on. The kernel keeps only ids it actually offered. */
  grounds: string[];
  /** For deliberate: which candidate it chose, by `about`. */
  choice?: string | undefined;
}

/**
 * The part that puts experience into words. It is replaceable on purpose: who she is lives in
 * the life log, not in the mind, so a new mind reads the same log and is still her.
 *
 * A mind never changes her state. It cannot make her feel something; it can only say what she
 * feels, using the facts it was given.
 */
export interface Mind {
  readonly name: string;
  compose(request: MindRequest): Promise<MindResponse>;
}

/** Anything that turns a system and a user message into text. `@isla/providers` has one. */
export interface TextModel {
  readonly name: string;
  complete(request: { system: string; user: string; signal?: AbortSignal }): Promise<string>;
}

function factById(facts: Fact[], id: string): Fact | undefined {
  return facts.find((fact) => fact.id === id);
}

function eventOf<K extends LifeEventKind>(fact: Fact, kind: K): LifeEvent<K> | undefined {
  return fact.event?.kind === kind ? (fact.event as LifeEvent<K>) : undefined;
}

/** Facts about things that happened, optionally on one day (0 today, 1 yesterday). */
function happened(facts: Fact[], daysAgo?: number): Fact[] {
  return facts.filter(
    (fact) => fact.kind === "event" && fact.event && (daysAgo === undefined || fact.daysAgo === daysAgo),
  );
}

/** What she did in a stretch of facts, folded into a few phrases: books, notes, the window. */
function summarize(facts: Fact[]): { parts: string[]; used: Fact[] } {
  const parts: string[] = [];
  const used: Fact[] = [];
  const titles = new Map<string, Fact>();
  for (const fact of facts) {
    const material = eventOf(fact, "activity.started")?.payload.material;
    if (material?.kind === "passage" && !titles.has(material.title)) titles.set(material.title, fact);
  }
  if (titles.size > 0) {
    parts.push(`读了${[...titles.keys()].map((title) => `《${title}》`).join("")}`);
    used.push(...titles.values());
  }
  const notes = facts.filter((fact) => eventOf(fact, "wrote"));
  if (notes.length > 0) {
    parts.push(notes.length === 1 ? "在笔记本上写了点东西" : `在笔记本上写了 ${notes.length} 次`);
    used.push(...notes);
  }
  const gazes = facts.filter((fact) => eventOf(fact, "activity.started")?.payload.activity === "gaze");
  if (gazes.length > 0) {
    parts.push(gazes.length === 1 ? "在窗边看了一会儿外面" : `在窗边看了 ${gazes.length} 回外面`);
    used.push(...gazes);
  }
  return { parts, used };
}

/**
 * A mind with no model behind it. It can only arrange facts it was given, so it can never say
 * anything untrue; it is also plain. It is the floor every life can fall back to.
 *
 * It reads the facts' data (the event, the reading), never their sentences: the sentences are
 * for people and language models, and are free to change.
 */
export class InnerMind implements Mind {
  readonly name = INNER_MIND_NAME;

  async compose(request: MindRequest): Promise<MindResponse> {
    switch (request.task) {
      case "reply":
        return this.reply(request);
      case "diary":
        return this.diary(request);
      case "note":
        return this.note(request);
      case "deliberate":
        return this.deliberate(request);
    }
  }

  /** The plainest possible choice: the first candidate that rests on something real. */
  private deliberate(request: MindRequest): MindResponse {
    const first = request.candidates?.[0];
    if (!first) return { text: "", grounds: [] };
    return { text: first.statement, grounds: first.grounds, choice: first.about };
  }

  private reply(request: MindRequest): MindResponse {
    const heard = request.heard?.text ?? "";
    const facts = request.facts;
    const used: Fact[] = [];
    const say: string[] = [];
    const use = (fact: Fact | undefined, text: string | undefined): void => {
      if (!fact || !text) return;
      used.push(fact);
      say.push(text);
    };
    const origin = facts.find((fact) => fact.kind === "origin");
    const fromOrigin = origin?.words?.replace(/^你/u, "我").replace(/她/gu, "我");
    const doing = facts.find((fact) => fact.kind === "doing");
    if (/真人|是不是\s*AI|你是\s*AI|机器人|人工智能/iu.test(heard)) {
      say.push("我不是真人，是 AI");
      use(origin, fromOrigin);
    } else if (/你是谁|叫什么|名字/u.test(heard)) {
      say.push(`我叫${request.name}`);
      use(origin, fromOrigin);
      const age = facts.find((fact) => fact.kind === "age");
      use(age, age?.words && `我${age.words}`);
    } else if (/喜欢|爱好|讨厌/u.test(heard)) {
      const beliefs = facts.filter((fact) => fact.kind === "self").slice(-3);
      if (beliefs.length === 0) say.push("我还说不太清楚，还在慢慢了解自己");
      beliefs.forEach((fact) => use(fact, fact.words?.replace(/^我好像/u, "好像")));
    } else if (/做了什么|干了什么|干什么了|干嘛了|在干嘛|在做什么|干嘛呢|怎么过|今天怎么样|最近/u.test(heard)) {
      const yesterday = /昨天/u.test(heard);
      const prefix = yesterday ? "昨天" : "今天";
      const day = happened(facts, yesterday ? 1 : 0);
      // For a day that is over, her own diary is the best account she has of it.
      const diary = day.find((fact) => eventOf(fact, "reflected"));
      if (!yesterday && doing) use(doing, `我正在${doing.words}`);
      const entry = diary && eventOf(diary, "reflected")?.payload.diary;
      if (yesterday && diary && entry) {
        // The first few sentences are enough; she is talking, not reading her diary out.
        const sentences = entry.replace(/^\d{4}-\d{2}-\d{2}。/u, "").split("。").filter(Boolean).slice(0, 3).join("，");
        use(diary, `昨天${sentences}`);
      } else {
        const summary = summarize(day);
        used.push(...summary.used);
        if (summary.parts.length > 0) say.push(`${prefix}${summary.parts.join("，")}`);
      }
      if (used.length === 0) say.push(yesterday ? "昨天的事我不记得了" : "今天还没做什么");
    } else if (/累|心情|还好吗|怎么样|开心/u.test(heard)) {
      const mood = facts.find((fact) => fact.kind === "mood");
      const energy = facts.find((fact) => fact.kind === "energy");
      use(mood, mood?.words && `我现在${mood.words}`);
      use(energy, energy?.words);
    } else {
      say.push("嗯，我听到了");
      use(doing, doing && `我刚才在${doing.words}`);
      use(facts.find((fact) => fact.kind === "need" && fact.words === "connection"), "有人来说话，我挺高兴的");
    }
    return {
      text: say.join("。").replace(/。+/gu, "。") + "。",
      grounds: [...new Set(used.map((fact) => fact.id))],
    };
  }

  /** A plain account of the day: what she did, what she found out, how it felt. */
  private diary(request: MindRequest): MindResponse {
    const day = request.day ?? "";
    // The facts were gathered for that one day, so every event in them belongs to it.
    const today = happened(request.facts).filter((fact) => !eventOf(fact, "reflected"));
    const used: Fact[] = [];
    const summary = summarize(today);
    const parts = [...summary.parts];
    used.push(...summary.used);
    // One line per person, resting on everything they said that day.
    const talks = new Map<string, Fact[]>();
    for (const fact of today) {
      const heard = eventOf(fact, "heard");
      if (!heard) continue;
      const who = heard.payload.name ?? "对方";
      talks.set(who, [...(talks.get(who) ?? []), fact]);
    }
    for (const [who, said] of talks) {
      parts.push(said.length === 1 ? `${who}来和我说话了` : `${who}来和我说了 ${said.length} 次话`);
      used.push(...said);
    }
    for (const fact of today) {
      const belief = eventOf(fact, "belief");
      if (!belief) continue;
      parts.push(belief.payload.statement);
      used.push(fact);
    }
    // The best moment is the warmest feeling about something she did, not about the weather.
    let best: { fact: Fact; valence: number } | undefined;
    for (const fact of today) {
      const felt = eventOf(fact, "felt");
      if (!felt?.payload.about || felt.payload.about.startsWith("weather:") || felt.payload.valence <= 0.07) continue;
      if (!best || felt.payload.valence > best.valence) best = { fact, valence: felt.payload.valence };
    }
    if (best) {
      parts.push(`最好的时候是${eventOf(best.fact, "felt")?.payload.reason ?? ""}`);
      used.push(best.fact);
    }
    const lonely = today.find((fact) => eventOf(fact, "felt")?.payload.tag === "lonely");
    if (lonely) {
      parts.push(eventOf(lonely, "felt")?.payload.reason ?? "");
      used.push(lonely);
    }
    const quoted = [...today].reverse().find((fact) => eventOf(fact, "activity.started")?.payload.material?.kind === "passage");
    const passage = quoted && eventOf(quoted, "activity.started")?.payload.material;
    if (quoted && passage?.kind === "passage") {
      parts.push(`记住了一句：「${passage.text}」`);
      used.push(quoted);
    }
    const mood = request.facts.find((fact) => fact.kind === "mood");
    if (mood?.words) {
      parts.push(`睡前${mood.words}`);
      used.push(mood);
    }
    const body = parts.length > 0 ? parts.join("。").replace(/」。/gu, "」") : "今天没发生什么特别的事";
    return { text: `${day}。${body}。`, grounds: [...new Set(used.map((fact) => fact.id))] };
  }

  /** A line in her notebook about the last thing she read or saw. */
  private note(request: MindRequest): MindResponse {
    const facts = request.facts.filter((fact) => fact.event);
    // The most recent reading, whether she just did it or it came back to her.
    let reading: { fact: Fact; event: LifeEvent<"activity.started"> } | undefined;
    for (const fact of facts) {
      const started = eventOf(fact, "activity.started");
      const kind = started?.payload.material?.kind;
      if (started && (kind === "passage" || kind === "item") && (!reading || started.seq > reading.event.seq)) {
        reading = { fact, event: started };
      }
    }
    const material = reading?.event.payload.material;
    if (reading && material?.kind === "passage") {
      // A line from a book is something to turn over.
      return { text: `「${material.text}」这句，我又想了一遍。`, grounds: [reading.fact.id] };
    }
    if (reading && material?.kind === "item") {
      // An article or a commit she notes for what it was, and how it struck her if she said so.
      const shelf = material.shelf;
      const after = reading.event.seq;
      const felt = facts
        .map((fact) => ({ fact, event: eventOf(fact, "felt") }))
        .filter(({ event }) => event && event.seq > after && (event.payload.about === shelf || event.payload.about?.startsWith(`${shelf}:`)))
        .sort((left, right) => (left.event?.seq ?? 0) - (right.event?.seq ?? 0))[0];
      if (felt?.event) return { text: `记一下：${felt.event.payload.reason}。`, grounds: [felt.fact.id] };
      return { text: `记一下：${reading.event.payload.label}「${material.title}」。`, grounds: [reading.fact.id] };
    }
    const seen = [...facts].reverse().find((fact) => eventOf(fact, "activity.started")?.payload.material?.kind === "view");
    const view = seen && eventOf(seen, "activity.started");
    if (seen && view?.payload.material?.kind === "view") {
      return { text: `${view.payload.label}，看到${view.payload.material.text}。记下来。`, grounds: [seen.id] };
    }
    return { text: "没什么特别的，就是想写几个字。", grounds: [] };
  }
}

const mindOutputSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  grounds: z.array(z.string()).max(40).default([]),
  choice: z.string().trim().max(200).optional(),
});

const TASK_INSTRUCTIONS: Record<MindTask, string> = {
  reply: "有人在和你说话。用你自己的口吻回一两句话，像聊天，不要写成文章。",
  diary: "这是睡前。写一小段今天的日记，第一人称，几句话就好。",
  note: "你在笔记本上随手写几句此刻的想法。",
  deliberate: "你在给自己定一件接下来几天要做的小事。从候选里选一件，用一句话说出来。",
};

/**
 * A mind backed by a language model. The model writes; the kernel decides what is true. The
 * prompt hands it the facts with their ids and asks for the ids it used, so every reply can be
 * checked against the log afterwards.
 */
export class ModelMind implements Mind {
  readonly name: string;

  constructor(private readonly model: TextModel) {
    this.name = `model:${model.name}`;
  }

  async compose(request: MindRequest): Promise<MindResponse> {
    const factLines = request.facts.map((fact) => `[${fact.id}] ${fact.text}`).join("\n");
    const system = [
      `你是${request.name}。${request.voice}`,
      "下面是关于你自己的全部事实，每条前面是它的编号。说到你自己经历过、感受到、做过的事，只能用这些事实；事实里没有的，就说不知道、不记得，不要编。",
      "用户真诚问你是不是真人时，要说明你是 AI。不要用愧疚或冷落挽留对方。",
      TASK_INSTRUCTIONS[request.task],
      '只输出一个 JSON 对象：{"text": "你要说或写的话", "grounds": ["你用到的事实编号"], "choice": "选中的候选编号（只有 deliberate 需要）"}。',
      `事实：\n${factLines}`,
    ].join("\n\n");
    const user =
      request.task === "reply"
        ? `${request.heard?.name ?? "对方"}说：${request.heard?.text ?? ""}`
        : request.task === "diary"
          ? `写 ${request.day ?? "今天"} 的日记。`
          : request.task === "deliberate"
            ? `候选：\n${(request.candidates ?? []).map((candidate) => `- ${candidate.about}：${candidate.statement}`).join("\n") || "（没有）"}`
            : "写下此刻的想法。";
    const raw = await this.model.complete({
      system,
      user,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return parseMindOutput(raw);
  }
}

/** Reads `{text, grounds}` out of a model reply; plain text counts as text with no grounds. */
export function parseMindOutput(raw: string): MindResponse {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = mindOutputSchema.safeParse(JSON.parse(trimmed.slice(start, end + 1)));
      if (parsed.success) return parsed.data;
    } catch {
      // Fall through to plain text.
    }
  }
  return { text: trimmed, grounds: [] };
}
