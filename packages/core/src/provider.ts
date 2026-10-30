import type { HistoryMessage, ModelProvider, ModelRequest, ModelResponse, SummaryRequest } from "./types.js";
import { z } from "zod";
import { buildSummaryPrompt } from "./prompt.js";

const STATE_MARKER = "[[COMPANION_STATE]]";
const EMOTION_MARKER = "[[COMPANION_EMOTION]]";
const emotionEventSchema = z.object({
  delta: z
    .object({
      pleasure: z.number().min(-1).max(1).optional(),
      arousal: z.number().min(-1).max(1).optional(),
      dominance: z.number().min(-1).max(1).optional(),
      trust: z.number().min(-1).max(1).optional(),
      bonding: z.number().min(-1).max(1).optional(),
      energy: z.number().min(-1).max(1).optional(),
    })
    .default({}),
  importance: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(300),
});

const memoryCandidateSchema = z.object({
  type: z.enum(["fact", "episode", "preference", "relationship", "self", "procedure"]),
  content: z.string().trim().min(1).max(2000),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  key: z.string().trim().min(1).max(120).optional(),
  supersedes: z.array(z.string().min(1)).max(5).optional(),
});

const companionStateSchema = z.object({
  emotionEvent: emotionEventSchema.optional(),
  memoryCandidates: z.array(memoryCandidateSchema).max(5).default([]),
});

const emotionProtocol = `
运行时协议：在自然语言回复末尾追加一行 ${STATE_MARKER}，后面紧跟一个 JSON 对象。JSON 格式为 {"emotionEvent":{"delta":{"pleasure":-1到1,"arousal":-1到1,"dominance":-1到1,"trust":-1到1,"bonding":-1到1,"energy":-1到1},"importance":0到1,"reason":"简短原因"},"memoryCandidates":[{"type":"fact|episode|preference|relationship|self|procedure","content":"稳定且可复用的用户信息","importance":0到1,"confidence":0到1,"key":"稳定逻辑键，如 preference.food","supersedes":["被替代的记忆 id"]}]}。没有明显情绪变化时使用空 delta；只记录用户明确表达、未来仍有价值的偏好、事实或长期目标，不要记录普通寒暄、一次性状态或你自己的猜测，最多提出 3 条候选。对于“现在不喜欢了”这类变化，使用同一个 key，让新事实替代旧版本；不要凭空填写 supersedes。不要把协议标记或 JSON 放进自然语言正文。`;

export class DemoProvider implements ModelProvider {
  readonly name = "demo";

  /** Echo reply in two short bubbles, in the companion's name, so the page can be tried offline. */
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const name = request.companionName ?? "我";
    const historyText = request.history.length ? `，前面聊了 ${request.history.length} 句` : "";
    const memoryText = request.memories[0] ? `，记得${request.memories[0].content.slice(0, 12)}` : "";
    const said = (request.userTexts ?? [request.userText]).join(" / ");
    return {
      text: `嗯嗯 ${name}在呢～${historyText}${memoryText}\n\n你刚才说：“${said}”`,
    };
  }

  /** Deterministic stand-in summary: previous summary plus the first words of each user message. */
  async summarize(request: SummaryRequest): Promise<string> {
    const userLines = request.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text.slice(0, 20));
    const latest = `${request.messages.length} 条消息里用户说过：${userLines.join("；") || "（无）"}`;
    const merged = request.previousSummary ? `${request.previousSummary}\n${latest}` : latest;
    return merged.slice(-1200);
  }
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * History as chat messages. Consecutive assistant bubbles become one message with blank lines
 * between them (the same format the model is asked to use); consecutive user messages stay
 * separate turns unless `mergeUsers` is set.
 */
export function historyToChatMessages(history: HistoryMessage[], options: { mergeUsers?: boolean } = {}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of history) {
    const previous = messages[messages.length - 1];
    if (previous && previous.role === item.role && (item.role === "assistant" || options.mergeUsers)) {
      previous.content = `${previous.content}${item.role === "assistant" ? "\n\n" : "\n"}${item.text}`;
    } else {
      messages.push({ role: item.role, content: item.text });
    }
  }
  return messages;
}

/** Merges every run of same-role messages, for endpoints that require strict alternation. */
export function mergeConsecutiveRoles(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role && message.role !== "system") {
      previous.content = `${previous.content}\n${message.content}`;
    } else {
      merged.push({ ...message });
    }
  }
  return merged;
}

class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail = "",
  ) {
    super(`Model request failed with status ${status}${detail ? `: ${detail}` : ""}`);
  }
}

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  embeddingModel?: string;
  timeoutMs?: number;
  /**
   * Upper bound for one reply, in tokens.
   *
   * Some OpenAI-compatible gateways default `max_tokens` to the model's whole
   * sequence window, so any non-trivial prompt then trips `max_tokens + prompt >
   * max_seq_len`. Sending an explicit value keeps the request valid.
   */
  maxTokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  private readonly options: OpenAICompatibleProviderOptions & { timeoutMs: number };

  constructor(options: OpenAICompatibleProviderOptions) {
    this.options = {
      timeoutMs: 30000,
      ...options,
    };
    this.name = `openai-compatible:${this.options.model}`;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const text = await this.complete(
      [
        { role: "system", content: `${request.systemPrompt}\n${emotionProtocol}` },
        ...historyToChatMessages(request.history ?? []),
        ...(request.userTexts?.length ? request.userTexts : [request.userText]).map(
          (content): ChatMessage => ({ role: "user", content }),
        ),
      ],
      0.8,
      request.signal,
    );
    return parseCompanionModelContent(text);
  }

  async summarize(request: SummaryRequest): Promise<string> {
    const prompt = buildSummaryPrompt(request);
    return this.complete(
      [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      0.3,
    );
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!this.options.embeddingModel || texts.length === 0) {
      return [];
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(this.options.timeoutMs, 10_000),
    );
    const requestSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/u, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({ model: this.options.embeddingModel, input: texts }),
        signal: requestSignal,
      });
      if (!response.ok) {
        throw new ModelHttpError(response.status);
      }
      const payload = (await response.json()) as EmbeddingResponse;
      const data = payload.data ?? [];
      const ordered = [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      if (ordered.length !== texts.length || ordered.some((item) => !item.embedding?.length || item.embedding.some((value) => !Number.isFinite(value)))) {
        throw new Error("Embedding response did not contain one vector per input");
      }
      return ordered.map((item) => item.embedding as number[]);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Sends the chat; if the endpoint rejects consecutive same-role messages (400), retries merged. */
  private async complete(
    messages: ChatMessage[],
    temperature: number,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      return await this.send(messages, temperature, signal);
    } catch (error: unknown) {
      const merged = mergeConsecutiveRoles(messages);
      if (error instanceof ModelHttpError && error.status === 400 && merged.length < messages.length) {
        return this.send(merged, temperature, signal);
      }
      throw error;
    }
  }

  private async send(
    messages: ChatMessage[],
    temperature: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature,
          messages,
          ...(this.options.maxTokens && this.options.maxTokens > 0
            ? { max_tokens: this.options.maxTokens }
            : {}),
        }),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new ModelHttpError(response.status, detail);
      }
      const payload = (await response.json()) as ChatCompletionResponse;
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) {
        throw new Error("Model response did not contain message content");
      }
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseCompanionModelContent(content: string): ModelResponse {
  const stateMarkerIndex = content.lastIndexOf(STATE_MARKER);
  if (stateMarkerIndex !== -1) {
    return parseStateContent(content, stateMarkerIndex, STATE_MARKER);
  }

  const markerIndex = content.lastIndexOf(EMOTION_MARKER);
  if (markerIndex === -1) {
    return { text: content.trim() };
  }

  const visibleText = content.slice(0, markerIndex).trim();
  const metadataText = content
    .slice(markerIndex + EMOTION_MARKER.length)
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");

  try {
    const parsed = emotionEventSchema.safeParse(JSON.parse(metadataText));
    if (!parsed.success || !visibleText) {
      return { text: content.trim() };
    }
    return {
      text: visibleText,
      emotionEvent: parsed.data,
    };
  } catch {
    return { text: visibleText || content.trim() };
  }
}

function parseStateContent(content: string, markerIndex: number, marker: string): ModelResponse {
  const visibleText = content.slice(0, markerIndex).trim();
  const metadataText = cleanMetadata(content.slice(markerIndex + marker.length));
  if (!visibleText) {
    return { text: content.trim() };
  }

  try {
    const parsed = companionStateSchema.safeParse(JSON.parse(metadataText));
    if (!parsed.success) {
      return { text: visibleText };
    }
    const result: ModelResponse = { text: visibleText };
    if (parsed.data.emotionEvent) {
      result.emotionEvent = parsed.data.emotionEvent;
    }
    if (parsed.data.memoryCandidates.length > 0) {
      result.memoryCandidates = parsed.data.memoryCandidates;
    }
    return result;
  } catch {
    return { text: visibleText };
  }
}

function cleanMetadata(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
}
