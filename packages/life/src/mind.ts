import { z } from "zod";
import { INNER_MIND_NAME } from "./events.js";
import type { Fact } from "./facts.js";

export type MindTask = "reply" | "diary" | "note";

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
  signal?: AbortSignal;
}

export interface MindResponse {
  text: string;
  /** Ids of the facts the text rests on. The kernel keeps only ids it actually offered. */
  grounds: string[];
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

function pick(facts: Fact[], test: (fact: Fact) => boolean, limit: number): Fact[] {
  return facts.filter(test).slice(-limit);
}

const isEvent = (fact: Fact): boolean => /^e\d+$/u.test(fact.id);

const DATED = /^(今天|昨天|前天|\d+月\d+日) \d{2}:\d{2} /u;

/** Strips the time prefix ("今天 14:30 ") so a fact reads as part of a sentence. */
function bare(text: string): string {
  return text.replace(DATED, "");
}

/** What she did in a stretch of facts, folded into a few phrases: books, notes, the window. */
function summarize(facts: Fact[]): { parts: string[]; used: Fact[] } {
  const parts: string[] = [];
  const used: Fact[] = [];
  const titles = new Map<string, Fact>();
  for (const fact of facts) {
    const title = /开始重?读《(.+?)》/u.exec(fact.text)?.[1];
    if (title && !titles.has(title)) titles.set(title, fact);
  }
  if (titles.size > 0) {
    parts.push(`读了${[...titles.keys()].map((title) => `《${title}》`).join("")}`);
    used.push(...titles.values());
  }
  const notes = facts.filter((fact) => fact.text.includes("在笔记本上写了"));
  if (notes.length > 0) {
    parts.push(notes.length === 1 ? "在笔记本上写了点东西" : `在笔记本上写了 ${notes.length} 次`);
    used.push(...notes);
  }
  const gazes = facts.filter((fact) => fact.text.includes("开始在窗边看外面"));
  if (gazes.length > 0) {
    parts.push(gazes.length === 1 ? "在窗边看了一会儿外面" : `在窗边看了 ${gazes.length} 回外面`);
    used.push(...gazes);
  }
  return { parts, used };
}

/**
 * A mind with no model behind it. It can only arrange facts it was given, so it can never say
 * anything untrue; it is also plain. It is the floor every life can fall back to.
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
    }
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
    const firstPerson = (fact: Fact | undefined): string | undefined =>
      fact?.text.replace(/^你的来历：/u, "").replace(/^你/u, "我").replace(/她/gu, "我");
    const origin = factById(facts, "genome:origin");
    const doing = facts.find((fact) => fact.text.startsWith("你此刻正在"));
    if (/真人|是不是\s*AI|你是\s*AI|机器人|人工智能/iu.test(heard)) {
      say.push("我不是真人，是 AI");
      use(origin, firstPerson(origin));
    } else if (/你是谁|叫什么|名字/u.test(heard)) {
      say.push(`我叫${request.name}`);
      use(origin, firstPerson(origin));
      const age = factById(facts, "state:age");
      use(age, firstPerson(age));
    } else if (/喜欢|爱好|讨厌/u.test(heard)) {
      const beliefs = pick(facts, (fact) => fact.text.startsWith("你对自己的认识："), 3);
      if (beliefs.length === 0) say.push("我还说不太清楚，还在慢慢了解自己");
      beliefs.forEach((fact) => use(fact, fact.text.replace(/^你对自己的认识：我好像/u, "好像")));
    } else if (/做了什么|干了什么|干什么了|干嘛了|在干嘛|在做什么|干嘛呢|怎么过|今天怎么样|最近/u.test(heard)) {
      const prefix = /昨天/u.test(heard) ? "昨天" : "今天";
      // For a day that is over, her own diary is the best account she has of it.
      const diary = facts.find((fact) => fact.text.startsWith(`${prefix} `) && fact.text.includes("写日记："));
      const day = facts.filter((fact) => isEvent(fact) && fact.text.startsWith(prefix));
      if (prefix === "今天" && doing) use(doing, doing.text.replace(/^你此刻正在/u, "我正在"));
      if (prefix === "昨天" && diary) {
        // The first few sentences are enough; she is talking, not reading her diary out.
        const entry = diary.text.replace(/^.*?写日记：(\d{4}-\d{2}-\d{2}。)?/u, "");
        const sentences = entry.split("。").filter(Boolean).slice(0, 3).join("，");
        use(diary, `昨天${sentences}`);
      } else {
        const summary = summarize(day);
        used.push(...summary.used);
        if (summary.parts.length > 0) say.push(`${prefix}${summary.parts.join("，")}`);
      }
      if (used.length === 0) say.push(prefix === "昨天" ? "昨天的事我不记得了" : "今天还没做什么");
    } else if (/累|心情|还好吗|怎么样|开心/u.test(heard)) {
      const mood = factById(facts, "state:mood");
      const energy = factById(facts, "state:energy");
      use(mood, firstPerson(mood));
      use(energy, energy?.text.replace(/^你现在/u, ""));
    } else {
      say.push("嗯，我听到了");
      use(doing, doing?.text.replace(/^你此刻正在/u, "我刚才在"));
      use(factById(facts, "state:connection"), "有人来说话，我挺高兴的");
    }
    return {
      text: say.join("。").replace(/。+/gu, "。") + "。",
      grounds: [...new Set(used.map((fact) => fact.id))],
    };
  }

  /** A plain account of the day: what she did, what she found out, how it felt. */
  private diary(request: MindRequest): MindResponse {
    const day = request.day ?? "";
    // The facts were gathered for that one day, so every dated event belongs to it.
    const today = request.facts.filter(
      (fact) => isEvent(fact) && DATED.test(fact.text) && !fact.text.includes("写日记"),
    );
    const used: Fact[] = [];
    const firstOf = (pattern: RegExp): Fact | undefined => today.find((fact) => pattern.test(fact.text));
    const summary = summarize(today);
    const parts = [...summary.parts];
    used.push(...summary.used);
    for (const fact of today.filter((item) => item.text.includes("对你说"))) {
      parts.push(bare(fact.text).replace(/对你说：.*/u, "来和我说话了"));
      used.push(fact);
    }
    for (const fact of today.filter((item) => item.text.includes("发现："))) {
      parts.push(fact.text.replace(/^.*发现：/u, ""));
      used.push(fact);
    }
    const best = firstOf(/入迷|很舒服|轻松了/u);
    if (best) {
      parts.push(`最好的时候是${bare(best.text)}`);
      used.push(best);
    }
    const lonely = firstOf(/没有人来说话/u);
    if (lonely) {
      parts.push(bare(lonely.text));
      used.push(lonely);
    }
    const quoted = [...today].reverse().find((fact) => fact.text.includes("读到「"));
    const passage = quoted ? /读到「(.+?)」/u.exec(quoted.text)?.[1] : undefined;
    if (quoted && passage) {
      parts.push(`记住了一句：「${passage}」`);
      used.push(quoted);
    }
    const mood = factById(request.facts, "state:mood");
    if (mood) {
      parts.push(`睡前${mood.text.replace(/^你现在/u, "")}`);
      used.push(mood);
    }
    const body = parts.length > 0 ? parts.join("。").replace(/」。/gu, "」") : "今天没发生什么特别的事";
    return { text: `${day}。${body}。`, grounds: [...new Set(used.map((fact) => fact.id))] };
  }

  private note(request: MindRequest): MindResponse {
    const reading = [...request.facts].reverse().find((fact) => isEvent(fact) && fact.text.includes("读到「"));
    if (reading) {
      const passage = /读到「(.+?)」/u.exec(reading.text)?.[1] ?? "";
      return { text: `「${passage}」这句，我又想了一遍。`, grounds: [reading.id] };
    }
    const seen = [...request.facts].reverse().find((fact) => isEvent(fact) && fact.text.includes("看到"));
    if (seen) return { text: `${bare(seen.text).replace(/^开始/u, "")}。记下来。`, grounds: [seen.id] };
    return { text: "没什么特别的，就是想写几个字。", grounds: [] };
  }
}

const mindOutputSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  grounds: z.array(z.string()).max(40).default([]),
});

const TASK_INSTRUCTIONS: Record<MindTask, string> = {
  reply: "有人在和你说话。用你自己的口吻回一两句话，像聊天，不要写成文章。",
  diary: "这是睡前。写一小段今天的日记，第一人称，几句话就好。",
  note: "你在笔记本上随手写几句此刻的想法。",
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
      '只输出一个 JSON 对象：{"text": "你要说或写的话", "grounds": ["你用到的事实编号"]}。',
      `事实：\n${factLines}`,
    ].join("\n\n");
    const user =
      request.task === "reply"
        ? `${request.heard?.name ?? "对方"}说：${request.heard?.text ?? ""}`
        : request.task === "diary"
          ? `写 ${request.day ?? "今天"} 的日记。`
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
