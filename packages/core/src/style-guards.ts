import type { HistoryMessage } from "./types.js";

const TRAILING_DECORATION = /[\s~～。.!！…\p{Extended_Pictographic}\u200d\ufe0f]+$/u;
const TRAILING_LAUGHTER = /(?:哈{2,}|嘿{2,}|嘻{2,}|h{3,})+$/iu;
const CLAUSE_BREAK = /[，,。.!！？?；;：:\n]/u;

/** Interrogative words that make a clause a question even without "？" (小满-style chats often drop it). */
const INTERROGATIVE = /(?:啥|什么|哪|咋|怎么|怎样|谁|为啥|是不是|有没有|要不要|会不会|能不能|行不行|好不好|对不对|几[点个天岁次])(?![都也])/u;
/** "A还是B" choices; statements like "我还是觉得…" or "饭还是要按点吃" are excluded. */
const CHOICE = /(?:^|[^我你他她它们也就都])还是(?!要|得|会|挺|很|蛮|比较|觉得|想|有点|算|应该|可以|老样子)/u;
/** Clauses that mention an interrogative word without asking anything ("谁劝都不好使", "我也不知道为什么"). */
const NOT_A_QUESTION = /不知道|不清楚|不管|无论|随便|没什么|不怎么|什么的|怎么说呢|(?:谁|啥|什么|哪|怎么).{0,2}[都也]/u;

/**
 * Whether a reply ends with a question: "？"/"?" or a closing 吗/呢 (ignoring trailing emoji, tildes
 * and laughter), or a last clause that asks without punctuation, e.g. "你今天是哪种", "后来圆回来没",
 * "无辣不欢还是跟我一样怂". Heuristic: it only looks at the last clause.
 */
export function endsWithQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (/[?？][\s~～\p{Extended_Pictographic}\u200d\ufe0f]*$/u.test(trimmed)) return true;
  const stripped = trimmed.replace(TRAILING_DECORATION, "").replace(TRAILING_LAUGHTER, "").replace(TRAILING_DECORATION, "");
  if (/[?？]$/u.test(stripped)) return true;
  const clause = stripped.split(CLAUSE_BREAK).pop()?.trim() ?? "";
  if (!clause) return false;
  if (/[吗呢]$/u.test(clause)) return true;
  if (/(?<![还也都并从可])没有?$/u.test(clause)) return true;
  if (NOT_A_QUESTION.test(clause)) return false;
  return INTERROGATIVE.test(clause) || CHOICE.test(clause);
}

/** Groups consecutive assistant messages (bubbles) into turns and returns the last `count` turns' text. */
export function recentAssistantTurns(history: HistoryMessage[], count: number): string[] {
  const turns: string[][] = [];
  let previousRole: HistoryMessage["role"] | undefined;
  for (const message of history) {
    if (message.role === "assistant") {
      if (previousRole === "assistant") turns[turns.length - 1]?.push(message.text);
      else turns.push([message.text]);
    }
    previousRole = message.role;
  }
  return turns.slice(-count).map((bubbles) => bubbles.join("\n"));
}

export interface QuestionGuard {
  /** How many of the last (up to) 3 assistant turns ended with a question (see endsWithQuestion). */
  questionEndings: number;
  turnsConsidered: number;
  lastEndedWithQuestion: boolean;
  /** True when this turn should not end with a question. */
  avoidQuestion: boolean;
}

export function questionGuard(history: HistoryMessage[]): QuestionGuard {
  const turns = recentAssistantTurns(history, 3);
  const flags = turns.map(endsWithQuestion);
  const questionEndings = flags.filter(Boolean).length;
  const lastEndedWithQuestion = flags[flags.length - 1] ?? false;
  return {
    questionEndings,
    turnsConsidered: turns.length,
    lastEndedWithQuestion,
    avoidQuestion: questionEndings >= 2 || lastEndedWithQuestion,
  };
}

function normalizeForCopy(text: string): string {
  return Array.from(text.replace(/[\s\p{P}\p{S}]/gu, "")).join("");
}

/**
 * Returns the first run of at least `minChars` characters (punctuation and spaces ignored) that the
 * reply shares with one of the example companion lines, or undefined.
 */
export function findCopiedExample(reply: string, examples: string[], minChars = 6): string | undefined {
  const normalizedReply = normalizeForCopy(reply);
  for (const example of examples) {
    const chars = Array.from(normalizeForCopy(example));
    for (let start = 0; start + minChars <= chars.length; start += 1) {
      const window = chars.slice(start, start + minChars).join("");
      if (normalizedReply.includes(window)) {
        // Extend the match as far as it goes, for a readable log line.
        let end = start + minChars;
        while (end < chars.length && normalizedReply.includes(chars.slice(start, end + 1).join(""))) end += 1;
        return chars.slice(start, end).join("");
      }
    }
  }
  return undefined;
}
