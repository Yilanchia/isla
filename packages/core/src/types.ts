export type MemoryType =
  | "fact"
  | "episode"
  | "preference"
  | "relationship"
  | "self"
  | "procedure";

export type MemoryOrigin = "user_explicit" | "model_extracted";

/** The only channel: the platform's own web chat. */
export type ChannelName = "platform";

export interface MemoryRecord {
  id: string;
  ownerId: string;
  companionId: string;
  type: MemoryType;
  content: string;
  importance: number;
  confidence: number;
  key?: string | undefined;
  origin?: MemoryOrigin | undefined;
  createdAt: number;
  lastAccessedAt: number;
  validFrom: number;
  validTo?: number | undefined;
  sourceMessageIds: string[];
  embedding?: number[] | undefined;
}

export interface MemoryCandidate {
  type: MemoryType;
  content: string;
  importance?: number | undefined;
  confidence?: number | undefined;
  /** Stable logical key used to version facts, e.g. "preference.food". */
  key?: string | undefined;
  /** Existing memory ids this candidate explicitly replaces. */
  supersedes?: string[] | undefined;
  origin?: MemoryOrigin | undefined;
  sourceMessageIds?: string[] | undefined;
  embedding?: number[] | undefined;
}

export interface RetrievedMemory extends MemoryRecord {
  score: number;
  components: {
    semantic: number;
    keyword: number;
    recency: number;
    importance: number;
    confidence: number;
    relationshipRelevance: number;
  };
}

export interface EmotionState {
  pleasure: number;
  arousal: number;
  dominance: number;
  trust: number;
  bonding: number;
  energy: number;
  updatedAt: number;
}

export interface EmotionDelta {
  pleasure?: number | undefined;
  arousal?: number | undefined;
  dominance?: number | undefined;
  trust?: number | undefined;
  bonding?: number | undefined;
  energy?: number | undefined;
}

export interface EmotionEvent {
  delta: EmotionDelta;
  importance: number;
  reason: string;
}

export interface EmotionEventRecord {
  id: string;
  ownerId: string;
  companionId: string;
  conversationId: string;
  messageId: string;
  event: EmotionEvent;
  occurredAt: number;
}

export interface CompanionEvent {
  id: string;
  type: "message.received" | "turn.completed" | "memory.created" | "proactive.due";
  ownerId: string;
  companionId: string;
  channel: ChannelName;
  payload: unknown;
  occurredAt: number;
}

/** One prior message of the conversation, as given to the model as working memory. */
export interface HistoryMessage {
  id?: string | undefined;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export interface SummaryRequest {
  /** Summary covering everything before `messages`, if any. */
  previousSummary?: string | undefined;
  /** The oldest not-yet-summarized messages, in chronological order. */
  messages: HistoryMessage[];
  companionName: string;
}

export interface ModelRequest {
  /** The user's message(s) of this turn joined with newlines. */
  userText: string;
  /** The user's messages of this turn, sent as consecutive user turns (burst input). */
  userTexts?: string[] | undefined;
  /** Display name of the companion, for providers that want it (e.g. the demo provider). */
  companionName?: string | undefined;
  systemPrompt: string;
  memories: RetrievedMemory[];
  emotion: EmotionState;
  /** Recent prior messages of this conversation (oldest first), excluding the current turn. */
  history: HistoryMessage[];
  /** Running summary of older messages that no longer fit into `history`. */
  summary?: string | undefined;
  /** Aborted when the user cancels the turn or the runtime timeout fires. */
  signal?: AbortSignal | undefined;
}

export interface ModelResponse {
  text: string;
  emotionEvent?: EmotionEvent | undefined;
  memoryCandidates?: MemoryCandidate[] | undefined;
  /** Real token usage from the provider, when it returns one. */
  usage?: { inputTokens: number; outputTokens: number } | undefined;
}

export interface ModelProvider {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  /** Optional semantic embeddings. Runtime falls back to local hashed vectors when absent/failing. */
  embed?(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  /** Folds old messages into the running summary; optional, the runtime falls back to generate(). */
  summarize?(request: SummaryRequest): Promise<string>;
}

export interface RuntimeInput {
  ownerId: string;
  companionId: string;
  conversationId: string;
  channel: ChannelName;
  /** One message, or several sent in a burst (answered together, stored separately). */
  text: string | string[];
  personality?: string | undefined;
  /** natural (default) paces bubbles like typing; instant shows them at once. */
  replyRhythm?: "natural" | "instant" | undefined;
  /** IANA timezone of the user (e.g. "Asia/Shanghai"); defaults to the runtime default. */
  timezone?: string | undefined;
  /** When the user's message was received; defaults to the runtime clock at handleMessage(). */
  receivedAt?: number | undefined;
  memoryCandidates?: MemoryCandidate[] | undefined;
  emotionEvent?: EmotionEvent | undefined;
  /** Lets the caller cancel a turn (e.g. the user closed the page or sent another message). */
  signal?: AbortSignal | undefined;
  /** Overrides the runtime's per-turn timeout for this call. */
  turnTimeoutMs?: number | undefined;
}

export interface StoredTurnMessage {
  id: string;
  text: string;
  createdAt: number;
}

export interface ReplyMessage extends StoredTurnMessage {
  /** Wait before showing this bubble, after the previous one (the first: after the response). */
  delayMs: number;
}

export interface TurnDebugInfo {
  /** Model call duration. */
  latencyMs: number;
  /** Whether a "don't end with a question" instruction was added this turn. */
  avoidQuestion: boolean;
  /** Recent assistant turns ending with a question / turns considered (before this reply). */
  recentQuestionEndings: number;
  recentTurnsConsidered: number;
  /** Whether this reply ends with a question. */
  endedWithQuestion: boolean;
  /** A ≥6-char run copied from the persona's example dialogues, if any. */
  copiedExample?: string | undefined;
  promptSections: string[];
  /** Embedding requests made this turn (0 when the provider has no embed()). */
  embeddingCalls: number;
  /** Records whose embedding was backfilled this turn. */
  embeddingsBackfilled: number;
}

/**
 * A small, host-facing summary of one turn: what the model saw, what it cost, how long it took.
 * `TurnDebugInfo` is for tests and prompt inspection; `TurnTrace` is for dashboards and budgets.
 */
export interface TurnTrace {
  promptSections: string[];
  memoriesUsed: number;
  historyMessages: number;
  /** Estimated input tokens (system prompt + history + current message). */
  inputTokens: number;
  /** Estimated output tokens (the reply). */
  outputTokens: number;
  /** Estimated cost in the governance policy's currency. 0 when no price is configured. */
  cost: number;
  /** Whether the token counts came from the provider or from `estimateTokens()`. */
  usageSource: "provider" | "estimated";
  latencyMs: number;
  provider: string;
}

export interface TurnResult {
  messageId: string;
  /** All bubbles joined with newlines (kept for older clients). */
  reply: string;
  /** The reply as chat bubbles with typing delays, in display order. */
  messages: ReplyMessage[];
  /** The user's message(s) of this turn as stored. */
  userMessages: StoredTurnMessage[];
  debug: TurnDebugInfo;
  provider: string;
  memoriesUsed: RetrievedMemory[];
  memoriesCreated: MemoryRecord[];
  memoriesUpdated: MemoryRecord[];
  emotion: EmotionState;
  emotionLabel: string;
  emotionEvent: EmotionEvent;
  /** Timestamp for the user's message (receipt time). */
  userMessageAt: number;
  /** Timestamp for the reply (generation completed); always later than userMessageAt. */
  repliedAt: number;
  /** What this turn saw and cost; safe to log or show in a dashboard. */
  trace: TurnTrace;
}
