/** Splitting replies into chat bubbles and pacing them like a person typing. */

export interface ReplyBubble {
  text: string;
  /** Wait before showing this bubble, measured from the previous one (or from the reply for the first). */
  delayMs: number;
}

export type ReplyRhythm = "natural" | "instant";

export interface SplitOptions {
  /** Preferred maximum bubble length in characters; longer sentences are kept whole. */
  maxBubbleChars?: number;
  maxBubbles?: number;
}

const SENTENCE_END = new Set(["。", "！", "？", "!", "?", "~", "～", "…", "；"]);
const OPENERS: Record<string, string> = { "「": "」", "『": "』", "“": "”", "‘": "’", "《": "》", "（": "）", "(": ")", "【": "】" };
const CLOSERS = new Set(Object.values(OPENERS));
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s，。！？、）)」』”’]+/giu;
const EMOJI_PART = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u200d\ufe0f\u20e3]/u;

function charLength(text: string): number {
  return Array.from(text).length;
}

/** Splits one paragraph into sentences, never inside quotes/brackets, URLs, numbers or emoji runs. */
export function splitSentences(paragraph: string): string[] {
  const chars = Array.from(paragraph);
  // Code-point indexes covered by URLs.
  const protectedIndexes = new Set<number>();
  for (const match of paragraph.matchAll(URL_PATTERN)) {
    const start = Array.from(paragraph.slice(0, match.index ?? 0)).length;
    const length = Array.from(match[0]).length;
    for (let index = start; index < start + length; index += 1) protectedIndexes.add(index);
  }
  const sentences: string[] = [];
  const stack: string[] = [];
  let asciiQuoteOpen = false;
  let current = "";
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? "";
    current += char;
    if (protectedIndexes.has(index)) continue;
    if (char === '"') {
      asciiQuoteOpen = !asciiQuoteOpen;
      continue;
    }
    const closer = OPENERS[char];
    if (closer) {
      stack.push(closer);
      continue;
    }
    if (CLOSERS.has(char)) {
      if (stack[stack.length - 1] === char) stack.pop();
      continue;
    }
    if (!SENTENCE_END.has(char) || stack.length > 0 || asciiQuoteOpen) continue;
    // "3.5" style numbers never reach here ('.' is not a sentence end); keep "?!"-runs, closing
    // quotes and trailing emoji with the sentence they finish.
    let next = index + 1;
    while (next < chars.length) {
      const following = chars[next] ?? "";
      if (SENTENCE_END.has(following) || CLOSERS.has(following) || EMOJI_PART.test(following)) {
        current += following;
        next += 1;
      } else {
        break;
      }
    }
    index = next - 1;
    if (current.trim()) sentences.push(current.trim());
    current = "";
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

function joinBubbles(left: string, right: string): string {
  const last = Array.from(left).pop() ?? "";
  const separator = SENTENCE_END.has(last) || CLOSERS.has(last) || EMOJI_PART.test(last) || /[，、,]/u.test(last) ? "" : " ";
  return `${left}${separator}${right}`;
}

/**
 * Turns a model reply into chat bubbles. Blank lines / line breaks written by the model are bubble
 * boundaries; paragraphs longer than maxBubbleChars are split at sentence ends and short sentences
 * re-grouped; at most maxBubbles bubbles (the shortest neighbours are merged).
 */
export function splitReply(text: string, options: SplitOptions = {}): string[] {
  const maxChars = options.maxBubbleChars ?? 40;
  const maxBubbles = options.maxBubbles ?? 4;
  const paragraphs = text
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const bubbles: string[] = [];
  for (const paragraph of paragraphs) {
    if (charLength(paragraph) <= maxChars) {
      bubbles.push(paragraph);
      continue;
    }
    let current = "";
    for (const sentence of splitSentences(paragraph)) {
      if (!current) {
        current = sentence;
      } else if (charLength(current) + charLength(sentence) <= maxChars) {
        current = joinBubbles(current, sentence);
      } else {
        bubbles.push(current);
        current = sentence;
      }
    }
    if (current) bubbles.push(current);
  }
  while (bubbles.length > maxBubbles) {
    let best = 0;
    for (let index = 1; index < bubbles.length - 1; index += 1) {
      const size = charLength(bubbles[index] ?? "") + charLength(bubbles[index + 1] ?? "");
      const bestSize = charLength(bubbles[best] ?? "") + charLength(bubbles[best + 1] ?? "");
      if (size < bestSize) best = index;
    }
    bubbles.splice(best, 2, joinBubbles(bubbles[best] ?? "", bubbles[best + 1] ?? ""));
  }
  return bubbles.length ? bubbles : [text.trim()];
}

export interface DelayOptions {
  mode?: ReplyRhythm;
  /** Model latency already spent since the user's message; subtracted from the first delay. */
  elapsedMs?: number;
  random?: () => number;
}

export const DELAY_BASE_MS = 400;
export const DELAY_PER_CHAR_MS = 60;
export const DELAY_CAP_MS = 4000;

/** Typing time for one bubble: 400ms + 60ms/char, ±20% jitter, capped at 4s. */
export function typingDelay(text: string, random: () => number = Math.random): number {
  const base = DELAY_BASE_MS + DELAY_PER_CHAR_MS * charLength(text);
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.round(Math.min(DELAY_CAP_MS, base * jitter));
}

export function paceBubbles(texts: string[], options: DelayOptions = {}): ReplyBubble[] {
  const random = options.random ?? Math.random;
  return texts.map((text, index) => {
    if (options.mode === "instant") return { text, delayMs: 0 };
    const delay = typingDelay(text, random);
    return { text, delayMs: index === 0 ? Math.max(0, delay - (options.elapsedMs ?? 0)) : delay };
  });
}
