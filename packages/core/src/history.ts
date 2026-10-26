import type { CompanionProfile } from "./profile.js";
import type { HistoryMessage } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export interface ConversationScope {
  ownerId: string;
  companionId: string;
  conversationId: string;
}

export interface ConversationSummary {
  summary: string;
  /** createdAt of the newest message folded into the summary. */
  coveredUntil: number;
  updatedAt: number;
}

/** Where the runtime reads a conversation's working memory from (the API backs it with SQLite). */
export interface ConversationHistorySource {
  /** The newest `limit` messages of the conversation, oldest first. */
  recentMessages(scope: ConversationScope, limit: number): MaybePromise<HistoryMessage[]>;
  /** Optional: when present the runtime persists each turn here, so hosts need no extra hook. */
  append?(scope: ConversationScope, message: HistoryMessage): MaybePromise<void>;
  /** Messages created strictly after `after`, oldest first, at most `limit`. Needed for summaries. */
  messagesAfter?(scope: ConversationScope, after: number, limit: number): MaybePromise<HistoryMessage[]>;
  /** createdAt of the user's newest stored message. */
  lastUserMessageAt?(scope: ConversationScope): MaybePromise<number | undefined>;
  getSummary?(scope: ConversationScope): MaybePromise<ConversationSummary | undefined>;
  saveSummary?(scope: ConversationScope, summary: ConversationSummary): MaybePromise<void>;
}

export interface CompanionProfileSource {
  get(companionId: string): MaybePromise<CompanionProfile | undefined>;
}

export function conversationKey(scope: ConversationScope): string {
  return `${scope.ownerId}\u0000${scope.companionId}\u0000${scope.conversationId}`;
}

/** Process-local history, used by the runtime when no persistent source is configured. */
export class InMemoryHistorySource implements Required<ConversationHistorySource> {
  private readonly messages = new Map<string, HistoryMessage[]>();
  private readonly summaries = new Map<string, ConversationSummary>();
  private sequence = 0;

  append(scope: ConversationScope, message: HistoryMessage): void {
    const key = conversationKey(scope);
    const list = this.messages.get(key) ?? [];
    list.push({ ...message, id: message.id ?? `memory-${(this.sequence += 1)}` });
    list.sort((left, right) => left.createdAt - right.createdAt);
    this.messages.set(key, list);
  }

  recentMessages(scope: ConversationScope, limit: number): HistoryMessage[] {
    const list = this.messages.get(conversationKey(scope)) ?? [];
    return limit > 0 ? list.slice(-limit).map((message) => ({ ...message })) : [];
  }

  messagesAfter(scope: ConversationScope, after: number, limit: number): HistoryMessage[] {
    return (this.messages.get(conversationKey(scope)) ?? [])
      .filter((message) => message.createdAt > after)
      .slice(0, limit)
      .map((message) => ({ ...message }));
  }

  lastUserMessageAt(scope: ConversationScope): number | undefined {
    const list = this.messages.get(conversationKey(scope)) ?? [];
    return [...list].reverse().find((message) => message.role === "user")?.createdAt;
  }

  getSummary(scope: ConversationScope): ConversationSummary | undefined {
    const summary = this.summaries.get(conversationKey(scope));
    return summary ? { ...summary } : undefined;
  }

  saveSummary(scope: ConversationScope, summary: ConversationSummary): void {
    this.summaries.set(conversationKey(scope), { ...summary });
  }
}
