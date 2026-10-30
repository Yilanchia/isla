import { randomUUID } from "node:crypto";
import { DEFAULT_COMPANION_PROFILE } from "./default-profile.js";
import {
  DEFAULT_EMOTION_STATE,
  decayEmotion,
  emotionLabel,
  updateEmotion,
  type EmotionConfig,
} from "./emotion.js";
import {
  conversationKey,
  InMemoryHistorySource,
  type CompanionProfileSource,
  type ConversationHistorySource,
  type ConversationScope,
  type ConversationSummary,
} from "./history.js";
import { MemoryStore, type MemoryRepository } from "./memory.js";
import { KeyedMutex } from "./mutex.js";
import { PluginRegistry } from "./plugin.js";
import type { CompanionProfile } from "./profile.js";
import {
  estimateRequestTokens,
  estimateTokens,
  Governance,
  TurnBlockedError,
} from "./governance.js";
import {
  buildPromptSections,
  buildSummaryPrompt,
  joinPromptSections,
  type PromptSection,
} from "./prompt.js";
import { DemoProvider } from "./provider.js";
import { paceBubbles, splitReply } from "./rhythm.js";
import {
  InMemoryEmotionStore,
  type CompanionStorage,
  type EmotionStore,
} from "./storage.js";
import { endsWithQuestion, findCopiedExample, questionGuard } from "./style-guards.js";
import { DEFAULT_TIMEZONE } from "./time.js";
import type {
  CompanionEvent,
  EmotionEvent,
  EmotionState,
  HistoryMessage,
  ModelProvider,
  ModelRequest,
  ReplyMessage,
  RuntimeInput,
  StoredTurnMessage,
  SummaryRequest,
  TurnResult,
  TurnTrace,
} from "./types.js";

/** Raised when a turn exceeds `turnTimeoutMs`. The caller decides whether to retry. */
export class TurnTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Turn timed out after ${timeoutMs} ms`);
    this.name = "TurnTimeoutError";
  }
}

export interface WorkingMemoryOptions {
  /** Max number of prior messages sent to the model. */
  historyLimit: number;
  /** Max total characters of those messages; the oldest are dropped first. */
  historyCharBudget: number;
  /** Summarize once more than this many unsummarized messages are older than the history window. */
  summaryThreshold: number;
  /** Max messages folded into the summary per run. */
  summaryChunkSize: number;
}

export const DEFAULT_WORKING_MEMORY: WorkingMemoryOptions = {
  historyLimit: 20,
  historyCharBudget: 6000,
  summaryThreshold: 40,
  summaryChunkSize: 60,
};

export interface PromptBuiltInfo {
  scope: ConversationScope;
  sections: PromptSection[];
  request: ModelRequest;
}

export interface StyleFlag {
  scope: ConversationScope;
  kind: "copied-example";
  detail: string;
  reply: string;
}

export interface RuntimeLogger {
  warn(message: string, error?: unknown): void;
}

export interface CompanionRuntimeOptions {
  /** Back all state with one object. Individual fields below override it. */
  storage?: CompanionStorage;
  /** Budget, pause switch and audit trail. Without it, every turn is allowed. */
  governance?: Governance;
  memory?: MemoryRepository;
  emotionStore?: EmotionStore;
  plugins?: PluginRegistry;
  provider?: ModelProvider;
  now?: () => number;
  onTurnCompleted?: (input: RuntimeInput, result: TurnResult) => Promise<void> | void;
  /** Persistent conversation history; without it the runtime keeps history in memory itself. */
  history?: ConversationHistorySource;
  /** Companion personas; unknown companions fall back to DEFAULT_COMPANION_PROFILE. */
  profiles?: CompanionProfileSource;
  /** Timezone used when a message does not carry one. */
  defaultTimezone?: string;
  workingMemory?: Partial<WorkingMemoryOptions>;
  /** Per-turn timeout. Default 60s. Set 0 to disable. */
  turnTimeoutMs?: number;
  /** How many missing memory embeddings to backfill per turn. Default 32. */
  embeddingBatchSize?: number;
  /** Tune how fast the six emotion dimensions decay. */
  emotionConfig?: EmotionConfig;
  /** Debug/test hook, called with the exact request right before the model is called. */
  onPromptBuilt?: (info: PromptBuiltInfo) => void;
  /** Called when a reply trips a style check (e.g. copies an example dialogue). */
  onStyleFlag?: (flag: StyleFlag) => void;
  /** Number of example dialogues shown per turn (random subset). Default 2. */
  exampleLimit?: number;
  /** Randomness for example rotation and typing jitter (injectable for tests). */
  random?: () => number;
  logger?: RuntimeLogger;
}

/**
 * One turn = load profile, memory, summary and history → build the prompt → call the model →
 * split the reply into paced bubbles → update memory and emotion → emit plugin events.
 *
 * Everything is injectable; the runtime itself never touches the network, the clock or a
 * database. That is what makes it testable and what lets a host swap any piece.
 */
export class CompanionRuntime {
  readonly memory: MemoryRepository;
  readonly plugins: PluginRegistry;
  readonly history: ConversationHistorySource;
  readonly emotionStore: EmotionStore;
  readonly governance: Governance | undefined;
  provider: ModelProvider;
  private readonly now: () => number;
  private readonly onTurnCompleted: CompanionRuntimeOptions["onTurnCompleted"];
  private readonly onPromptBuilt: CompanionRuntimeOptions["onPromptBuilt"];
  private readonly profiles: CompanionProfileSource | undefined;
  private readonly defaultTimezone: string;
  private readonly workingMemory: WorkingMemoryOptions;
  private readonly logger: RuntimeLogger;
  private localHistory: InMemoryHistorySource | undefined;
  private readonly turnLock = new KeyedMutex();
  private readonly summarizing = new Set<string>();
  private readonly background = new Set<Promise<void>>();
  private readonly onStyleFlag: CompanionRuntimeOptions["onStyleFlag"];
  private readonly exampleLimit: number;
  private readonly random: () => number;
  private readonly turnTimeoutMs: number;
  private readonly embeddingBatchSize: number;
  private readonly emotionConfig: EmotionConfig | undefined;

  constructor(options: CompanionRuntimeOptions = {}) {
    this.memory = options.memory ?? options.storage?.memory ?? new MemoryStore();
    this.emotionStore =
      options.emotionStore ?? options.storage?.emotion ?? new InMemoryEmotionStore();
    this.governance = options.governance;
    this.plugins = options.plugins ?? new PluginRegistry();
    this.provider = options.provider ?? new DemoProvider();
    this.now = options.now ?? Date.now;
    this.onTurnCompleted = options.onTurnCompleted;
    this.onPromptBuilt = options.onPromptBuilt;
    this.onStyleFlag = options.onStyleFlag;
    this.exampleLimit = options.exampleLimit ?? 2;
    this.random = options.random ?? Math.random;
    this.profiles = options.profiles;
    this.defaultTimezone = options.defaultTimezone ?? DEFAULT_TIMEZONE;
    this.workingMemory = { ...DEFAULT_WORKING_MEMORY, ...options.workingMemory };
    this.turnTimeoutMs = options.turnTimeoutMs ?? 60_000;
    this.embeddingBatchSize = Math.max(0, options.embeddingBatchSize ?? 32);
    this.emotionConfig = options.emotionConfig;
    this.logger = options.logger ?? {
      warn: (message, error) => console.warn(message, error),
    };
    if (options.history) {
      this.history = options.history;
    } else if (options.storage?.history) {
      this.history = options.storage.history;
    } else {
      this.localHistory = new InMemoryHistorySource();
      this.history = this.localHistory;
    }
  }

  setProvider(provider: ModelProvider): void {
    this.provider = provider;
  }

  restoreEmotion(ownerId: string, companionId: string, emotion: EmotionState): void {
    this.emotionStore.set({ ownerId, companionId }, { ...emotion });
  }

  listEmotionStates(): Array<{ ownerId: string; companionId: string; state: EmotionState }> {
    return this.emotionStore.list().map(({ scope, state }) => ({
      ownerId: scope.ownerId,
      companionId: scope.companionId,
      state: { ...state },
    }));
  }

  /** Drops stored emotion for a deleted companion. */
  forgetCompanion(ownerId: string, companionId: string): void {
    this.emotionStore.delete({ ownerId, companionId });
  }

  getEmotion(ownerId: string, companionId: string): EmotionState {
    const stored = this.emotionStore.get({ ownerId, companionId });
    return stored ? { ...stored } : { ...DEFAULT_EMOTION_STATE, updatedAt: this.now() };
  }

  /** Turns on the same conversation run one at a time, in arrival order. */
  async handleMessage(input: RuntimeInput): Promise<TurnResult> {
    const receivedAt = input.receivedAt ?? this.now();
    const scope: ConversationScope = {
      ownerId: input.ownerId,
      companionId: input.companionId,
      conversationId: input.conversationId,
    };
    return this.turnLock.run(conversationKey(scope), () => this.runTurn(input, scope, receivedAt));
  }

  /** Resolves once background work (conversation summaries) has finished; for tests and shutdown. */
  async waitForBackgroundTasks(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.allSettled([...this.background]);
    }
  }

  private async runTurn(
    input: RuntimeInput,
    scope: ConversationScope,
    receivedAt: number,
  ): Promise<TurnResult> {
    const now = this.now();
    const messageId = randomUUID();
    const userTexts = (Array.isArray(input.text) ? input.text : [input.text])
      .map((text) => text.trim())
      .filter(Boolean);
    const userText = userTexts.join("\n");
    const emotion = decayEmotion(
      this.getEmotion(input.ownerId, input.companionId),
      now,
      this.emotionConfig ? { config: this.emotionConfig } : {},
    );
    const recordsWithoutEmbeddings = this.memory
      .list({ ownerId: input.ownerId, companionId: input.companionId })
      .filter((record) => !record.embedding)
      .slice(0, this.embeddingBatchSize);
    const canEmbed = Boolean(this.provider.embed);
    const [embeddingBatch, profile, summary, recent, storedLastUserAt] = await Promise.all([
      canEmbed
        ? this.embedTexts([userText, ...recordsWithoutEmbeddings.map((record) => record.content)])
        : Promise.resolve([]),
      this.loadProfile(input.companionId),
      this.history.getSummary?.(scope),
      this.history.recentMessages(scope, this.workingMemory.historyLimit),
      this.history.lastUserMessageAt?.(scope),
    ]);
    let embeddingsBackfilled = 0;
    const queryEmbedding = embeddingBatch[0];
    if (embeddingBatch.length === recordsWithoutEmbeddings.length + 1) {
      recordsWithoutEmbeddings.forEach((record, index) => {
        const embedding = embeddingBatch[index + 1];
        if (embedding && this.memory.setEmbedding(record.id, embedding)) {
          embeddingsBackfilled += 1;
        }
      });
    }
    const memories = this.memory.search(userText, {
      ownerId: input.ownerId,
      companionId: input.companionId,
      limit: 8,
      now,
      ...(queryEmbedding ? { embedding: queryEmbedding } : {}),
    });
    const history = selectHistory(recent, summary?.coveredUntil, this.workingMemory);
    const lastUserMessageAt =
      storedLastUserAt ?? [...recent].reverse().find((message) => message.role === "user")?.createdAt;
    const guard = questionGuard(recent);
    const turnInstructions: string[] = [];
    if (guard.avoidQuestion) {
      turnInstructions.push(
        "这轮不要用问句结尾：用陈述、吐槽、分享自己的想法或感受来收尾，不要以“吗/呢/？”结束。",
      );
    }
    if (userTexts.length > 1) {
      turnInstructions.push(
        `对方刚才连着发了 ${userTexts.length} 条消息，一起自然地回应就好，不用逐条回答。`,
      );
    }
    const sections = buildPromptSections({
      profile,
      personalityOverride: input.personality,
      emotion,
      memories,
      summary: summary?.summary,
      now,
      timezone: input.timezone ?? this.defaultTimezone,
      lastUserMessageAt,
      hasHistory: recent.length > 0,
      turnInstructions,
      exampleLimit: this.exampleLimit,
      random: this.random,
    });
    const request: ModelRequest = {
      userText,
      userTexts,
      companionName: profile.name,
      systemPrompt: joinPromptSections(sections),
      memories,
      emotion,
      history,
      ...(summary?.summary ? { summary: summary.summary } : {}),
    };
    const estimatedInputTokens = estimateRequestTokens({
      systemPrompt: request.systemPrompt,
      history: request.history.map((message) => message.text),
      userText: request.userText,
    });
    const decision = this.governance?.canStart(
      { ownerId: input.ownerId },
      { inputTokens: estimatedInputTokens },
    );
    if (decision && !decision.allowed) {
      this.governance?.recordBlocked(scope, decision.reason, decision.detail);
      throw new TurnBlockedError(decision.reason, decision.detail);
    }
    safeCall(() => this.onPromptBuilt?.({ scope, sections, request }), this.logger, "onPromptBuilt");
    const generationStartedAt = this.now();
    const response = await this.generateWithDeadline(request, input);
    const repliedAt = Math.max(this.now(), receivedAt + 1);
    const bubbles = paceBubbles(splitReply(response.text), {
      mode: input.replyRhythm ?? "natural",
      elapsedMs: Math.max(0, repliedAt - receivedAt),
      random: this.random,
    });
    // Bubbles of this turn are shown after the previous turn's bubbles (the page plays replies in
    // order), so stamp them after the newest stored message as well.
    const newestStoredAt = recent[recent.length - 1]?.createdAt ?? 0;
    const firstBubbleBase = Math.max(repliedAt, newestStoredAt + 1);
    let cursor = firstBubbleBase;
    const messages: ReplyMessage[] = bubbles.map((bubble, index) => {
      cursor = index === 0 ? firstBubbleBase + bubble.delayMs : cursor + Math.max(1, bubble.delayMs);
      return {
        id: index === 0 ? `${messageId}:assistant` : `${messageId}:assistant:${index}`,
        text: bubble.text,
        delayMs: bubble.delayMs,
        createdAt: cursor,
      };
    });
    const userMessages: StoredTurnMessage[] = userTexts.map((text, index) => ({
      id: index === 0 ? `${messageId}:user` : `${messageId}:user:${index}`,
      text,
      createdAt: receivedAt - (userTexts.length - 1 - index),
    }));
    const reply = messages.map((message) => message.text).join("\n");
    const copiedExample = findCopiedExample(
      response.text,
      profile.exampleDialogues.map((dialogue) => dialogue.companion),
    );
    const automaticCandidates = (response.memoryCandidates ?? [])
      .filter(
        (candidate) =>
          (candidate.importance ?? 0.5) >= 0.65 && (candidate.confidence ?? 0.7) >= 0.75,
      )
      .map((candidate) => ({ ...candidate, origin: "model_extracted" as const }));
    const candidates = [
      ...(input.memoryCandidates ?? []).map((candidate) => ({
        ...candidate,
        origin: "user_explicit" as const,
      })),
      ...automaticCandidates,
    ];
    const candidateEmbeddings = canEmbed
      ? await this.embedTexts(candidates.map((candidate) => candidate.content))
      : [];
    const createdMemories = candidates.map((candidate, index) => {
      const embedding = candidate.embedding ?? candidateEmbeddings[index];
      return this.memory.add(
        {
          ...candidate,
          ...(embedding ? { embedding } : {}),
          sourceMessageIds: [...new Set([...(candidate.sourceMessageIds ?? []), messageId])],
        },
        {
          ownerId: input.ownerId,
          companionId: input.companionId,
          now,
        },
      );
    });
    const memoriesUpdated = this.memory.takeUpdatedRecords();
    const emotionEvent = input.emotionEvent ??
      response.emotionEvent ?? { delta: {}, importance: 0, reason: "turn" };
    const nextEmotion = updateEmotion(
      emotion,
      emotionEvent,
      this.emotionConfig ? { config: this.emotionConfig, now } : { now },
    );
    this.emotionStore.set(
      { ownerId: input.ownerId, companionId: input.companionId },
      nextEmotion,
    );
    await this.dispatch(input, messageId, userText, reply, createdMemories, emotionEvent);
    const latencyMs = Math.max(0, repliedAt - generationStartedAt);
    const usageSource = response.usage ? "provider" : "estimated";
    const inputTokens = response.usage?.inputTokens ?? estimatedInputTokens;
    const outputTokens = response.usage?.outputTokens ?? estimateTokens(reply);
    const cost =
      this.governance?.recordTurn(scope, {
        inputTokens,
        outputTokens,
        latencyMs,
        provider: this.provider.name,
      }) ?? 0;
    const trace: TurnTrace = {
      promptSections: sections.map((section) => section.id),
      memoriesUsed: memories.length,
      historyMessages: history.length,
      inputTokens,
      outputTokens,
      cost,
      usageSource,
      latencyMs,
      provider: this.provider.name,
    };
    const result: TurnResult = {
      messageId,
      reply,
      messages,
      userMessages,
      debug: {
        latencyMs,
        avoidQuestion: guard.avoidQuestion,
        recentQuestionEndings: guard.questionEndings,
        recentTurnsConsidered: guard.turnsConsidered,
        endedWithQuestion: endsWithQuestion(messages[messages.length - 1]?.text ?? ""),
        ...(copiedExample ? { copiedExample } : {}),
        promptSections: sections.map((section) => section.id),
        embeddingCalls: canEmbed ? (candidates.length > 0 ? 2 : 1) : 0,
        embeddingsBackfilled,
      },
      provider: this.provider.name,
      memoriesUsed: memories,
      memoriesCreated: createdMemories,
      memoriesUpdated,
      emotion: nextEmotion,
      emotionLabel: emotionLabel(nextEmotion),
      emotionEvent,
      userMessageAt: receivedAt,
      repliedAt,
      trace,
    };
    if (copiedExample) {
      safeCall(
        () => this.onStyleFlag?.({ scope, kind: "copied-example", detail: copiedExample, reply }),
        this.logger,
        "onStyleFlag",
      );
    }
    if (this.localHistory || this.history.append) {
      const writer = this.localHistory ?? this.history;
      for (const message of userMessages) {
        await writer.append?.(scope, {
          id: message.id,
          role: "user",
          text: message.text,
          createdAt: message.createdAt,
        });
      }
      for (const message of messages) {
        await writer.append?.(scope, {
          id: message.id,
          role: "assistant",
          text: message.text,
          createdAt: message.createdAt,
        });
      }
    }
    try {
      await this.onTurnCompleted?.(input, result);
    } catch (error: unknown) {
      this.logger.warn("onTurnCompleted failed", error);
    }
    this.scheduleSummary(scope, profile.name);
    return result;
  }

  /** Calls the model with a timeout and the caller's abort signal. */
  private async generateWithDeadline(
    request: ModelRequest,
    input: RuntimeInput,
  ): Promise<Awaited<ReturnType<ModelProvider["generate"]>>> {
    const timeoutMs = input.turnTimeoutMs ?? this.turnTimeoutMs;
    if (timeoutMs <= 0) {
      return this.provider.generate(
        input.signal ? { ...request, signal: input.signal } : request,
      );
    }
    const timeoutController = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutController.signal])
      : timeoutController.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timeoutController.abort(new TurnTimeoutError(timeoutMs));
        reject(new TurnTimeoutError(timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });
    const generation = this.provider.generate({ ...request, signal });
    // If the deadline wins the race, the late rejection must not become unhandled.
    generation.catch(() => undefined);
    try {
      return await Promise.race([generation, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async loadProfile(companionId: string): Promise<CompanionProfile> {
    try {
      return (await this.profiles?.get(companionId)) ?? DEFAULT_COMPANION_PROFILE;
    } catch (error: unknown) {
      this.logger.warn(`failed to load companion profile ${companionId}; using the default`, error);
      return DEFAULT_COMPANION_PROFILE;
    }
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    if (!this.provider.embed || texts.length === 0) {
      return [];
    }
    try {
      return await this.provider.embed(texts);
    } catch (error: unknown) {
      this.logger.warn("embedding failed; using local fallback vectors", error);
      return [];
    }
  }

  /** Starts a background summary run when enough old messages piled up. Never awaited by turns. */
  private scheduleSummary(scope: ConversationScope, companionName: string): void {
    const source = this.history;
    if (!source.getSummary || !source.saveSummary || !source.messagesAfter) {
      return;
    }
    const key = conversationKey(scope);
    if (this.summarizing.has(key)) {
      return;
    }
    this.summarizing.add(key);
    const task = this.summarizeIfNeeded(scope, companionName)
      .catch((error: unknown) =>
        this.logger.warn("conversation summary failed; will retry after a later turn", error),
      )
      .finally(() => {
        this.summarizing.delete(key);
        this.background.delete(task);
      });
    this.background.add(task);
  }

  private async summarizeIfNeeded(scope: ConversationScope, companionName: string): Promise<void> {
    const source = this.history;
    const { historyLimit, summaryThreshold, summaryChunkSize } = this.workingMemory;
    const previous = await source.getSummary?.(scope);
    const window = await source.recentMessages(scope, historyLimit);
    const windowStart = window[0];
    if (!windowStart || window.length < historyLimit) {
      return;
    }
    const windowIds = new Set(window.map((message) => message.id).filter((id): id is string => Boolean(id)));
    const candidates =
      (await source.messagesAfter?.(
        scope,
        previous?.coveredUntil ?? -1,
        summaryChunkSize + historyLimit + 1,
      )) ?? [];
    const older = candidates.filter((message) =>
      message.id && windowIds.size > 0
        ? !windowIds.has(message.id)
        : message.createdAt < windowStart.createdAt,
    );
    if (older.length <= summaryThreshold) {
      return;
    }
    let end = Math.min(summaryChunkSize, older.length);
    // Never split messages sharing one timestamp across the coveredUntil boundary.
    const next = older[end] ?? windowStart;
    while (end > 0 && older[end - 1]?.createdAt === next.createdAt) {
      end -= 1;
    }
    const chunk = older.slice(0, end);
    const last = chunk[chunk.length - 1];
    if (!last) {
      return;
    }
    const request: SummaryRequest = {
      previousSummary: previous?.summary,
      messages: chunk.map(({ role, text, createdAt }) => ({ role, text, createdAt })),
      companionName,
    };
    const text = (await this.summarize(request)).trim();
    if (!text) {
      throw new Error("model returned an empty summary");
    }
    const summary: ConversationSummary = {
      summary: text,
      coveredUntil: last.createdAt,
      updatedAt: this.now(),
    };
    await source.saveSummary?.(scope, summary);
  }

  private async summarize(request: SummaryRequest): Promise<string> {
    if (this.provider.summarize) {
      return this.provider.summarize(request);
    }
    const prompt = buildSummaryPrompt(request);
    const response = await this.provider.generate({
      userText: prompt.user,
      systemPrompt: prompt.system,
      memories: [],
      emotion: { ...DEFAULT_EMOTION_STATE, updatedAt: this.now() },
      history: [],
    });
    return response.text;
  }

  private async dispatch(
    input: RuntimeInput,
    messageId: string,
    text: string,
    reply: string,
    memoriesCreated: unknown[],
    emotionEvent: EmotionEvent,
  ): Promise<void> {
    const eventBase = {
      id: randomUUID(),
      ownerId: input.ownerId,
      companionId: input.companionId,
      channel: input.channel,
      occurredAt: this.now(),
    } satisfies Omit<CompanionEvent, "type" | "payload">;
    await this.plugins.dispatch({
      ...eventBase,
      type: "message.received",
      payload: { messageId, conversationId: input.conversationId, text },
    });
    await this.plugins.dispatch({
      ...eventBase,
      type: "turn.completed",
      payload: { messageId, conversationId: input.conversationId, reply, memoriesCreated, emotionEvent },
    });
  }
}

function safeCall(action: () => void, logger: RuntimeLogger, name: string): void {
  try {
    action();
  } catch (error: unknown) {
    logger.warn(`${name} callback failed`, error);
  }
}

/**
 * Picks the working-memory window: messages not yet covered by the summary, newest first until
 * the count or character budget is reached, returned oldest first.
 */
export function selectHistory(
  recent: HistoryMessage[],
  coveredUntil: number | undefined,
  options: Pick<WorkingMemoryOptions, "historyLimit" | "historyCharBudget">,
): HistoryMessage[] {
  const eligible = recent
    .filter((message) => coveredUntil === undefined || message.createdAt > coveredUntil)
    .slice(-options.historyLimit);
  const picked: HistoryMessage[] = [];
  let used = 0;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const message = eligible[index];
    if (!message) continue;
    if (used + message.text.length > options.historyCharBudget) {
      if (picked.length === 0) {
        picked.unshift({
          role: message.role,
          text: message.text.slice(-options.historyCharBudget),
          createdAt: message.createdAt,
        });
      }
      break;
    }
    used += message.text.length;
    picked.unshift({ role: message.role, text: message.text, createdAt: message.createdAt });
  }
  return picked;
}
