import {
  InMemoryHistorySource,
  type ConversationHistorySource,
  type ConversationScope,
} from "./history.js";
import { InMemoryUsageStore, type UsageStore } from "./governance.js";
import { MemoryStore, type MemoryRepository } from "./memory.js";
import type { ProactiveStore } from "./scheduler.js";
import type { EmotionState } from "./types.js";

/**
 * Emotion belongs to a (user, companion) pair, not to a single conversation: switching
 * conversations should not reset how the companion feels.
 */
export interface EmotionScope {
  ownerId: string;
  companionId: string;
}

/**
 * Emotion state is small and read on every turn, so this interface is synchronous on purpose.
 * SQLite's node:sqlite driver is synchronous too; a network-backed store can cache locally
 * and flush in the background.
 */
export interface EmotionStore {
  get(scope: EmotionScope): EmotionState | undefined;
  set(scope: EmotionScope, state: EmotionState): void;
  list(): Array<{ scope: EmotionScope; state: EmotionState }>;
  delete(scope: EmotionScope): void;
}

export class InMemoryEmotionStore implements EmotionStore {
  private readonly states = new Map<string, { scope: EmotionScope; state: EmotionState }>();

  get(scope: EmotionScope): EmotionState | undefined {
    return this.states.get(keyOf(scope))?.state;
  }

  set(scope: EmotionScope, state: EmotionState): void {
    this.states.set(keyOf(scope), { scope: { ...scope }, state: { ...state } });
  }

  list(): Array<{ scope: EmotionScope; state: EmotionState }> {
    return [...this.states.values()].map((entry) => ({
      scope: { ...entry.scope },
      state: { ...entry.state },
    }));
  }

  delete(scope: EmotionScope): void {
    this.states.delete(keyOf(scope));
  }
}

/**
 * Everything the runtime needs to persist, grouped in one object.
 *
 * `InMemoryStorage` is the zero-config default (useful for tests, demos and embedding Isla
 * in another process). For a real deployment use `@isla/store-sqlite` or implement this
 * interface against your own database.
 */
export interface CompanionStorage {
  memory: MemoryRepository;
  history: ConversationHistorySource;
  emotion: EmotionStore;
  proactive?: ProactiveStore;
  /** Optional: when present, `Governance` can persist daily budgets across restarts. */
  usage?: UsageStore;
}

export class InMemoryStorage implements CompanionStorage {
  readonly memory = new MemoryStore();
  readonly history = new InMemoryHistorySource();
  readonly emotion = new InMemoryEmotionStore();
  readonly usage = new InMemoryUsageStore();
}

export function keyOf(scope: EmotionScope | ConversationScope): string {
  const conversationId = "conversationId" in scope ? scope.conversationId : "";
  return `${scope.ownerId}\u0000${scope.companionId}\u0000${conversationId}`;
}
