import { randomUUID } from "node:crypto";

/**
 * How much a companion is allowed to spend, and when it must stop.
 *
 * Every limit is expressed in estimated tokens; `0` means "no limit". The estimates are
 * deliberately cheap (a CJK character counts as one token, other text as a quarter), so they
 * are a budget guard, not an invoice. Use real provider usage for billing.
 */
export interface GovernancePolicy {
  /** Hard stop. While paused, no new turns are generated. */
  paused: boolean;
  /** Max estimated input tokens for one turn. */
  maxInputTokensPerTurn: number;
  /** Max estimated output tokens for one turn. */
  maxOutputTokensPerTurn: number;
  /** Max estimated tokens per local calendar day, per owner. */
  maxTokensPerDay: number;
  /** Max estimated cost per local calendar day, per owner. 0 = no limit. */
  maxCostPerDay: number;
  /** Max estimated tokens per local calendar day for background work (summaries). 0 = no limit. */
  maxBackgroundTokensPerDay: number;
  /** Price per million input tokens, in any currency. */
  pricePerMillionInputTokens: number;
  /** Price per million output tokens, in any currency. */
  pricePerMillionOutputTokens: number;
  /** Used to reserve output budget before generation. Default 256. */
  expectedOutputTokens: number;
  /** Timezone for the daily reset. Default Asia/Shanghai. */
  timezone: string;
}

export const DEFAULT_GOVERNANCE_POLICY: GovernancePolicy = {
  paused: false,
  maxInputTokensPerTurn: 0,
  maxOutputTokensPerTurn: 0,
  maxTokensPerDay: 0,
  maxCostPerDay: 0,
  maxBackgroundTokensPerDay: 0,
  pricePerMillionInputTokens: 0,
  pricePerMillionOutputTokens: 0,
  expectedOutputTokens: 256,
  timezone: "Asia/Shanghai",
};

export type GovernanceBlockReason =
  | "paused"
  | "turn_input_budget"
  | "turn_output_budget"
  | "day_token_budget"
  | "day_cost_budget"
  | "background_token_budget";

export type GovernanceDecision =
  | { allowed: true }
  | { allowed: false; reason: GovernanceBlockReason; detail: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TurnUsage extends TokenUsage {
  latencyMs: number;
  provider: string;
}

export type AuditType =
  | "turn.completed"
  | "turn.blocked"
  | "summary.completed"
  | "summary.blocked"
  | "governance.paused"
  | "governance.resumed"
  | "governance.policy_changed";

export interface AuditEntry {
  id: string;
  at: number;
  type: AuditType;
  ownerId?: string;
  companionId?: string;
  detail: string;
  data?: Record<string, unknown>;
}

export interface AuditSink {
  append(entry: AuditEntry): void | Promise<void>;
}

export class MemoryAuditSink implements AuditSink {
  private readonly entries: AuditEntry[] = [];
  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  append(entry: AuditEntry): void {
    this.entries.push({ ...entry });
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  list(): AuditEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

export interface UsageSnapshot {
  tokens: number;
  cost: number;
}

/**
 * Where the daily usage counters live. Implement it to survive a restart (the SQLite adapter
 * does) or to share a budget between processes (a future Redis adapter).
 */
export interface UsageStore {
  get(ownerId: string, day: string): UsageSnapshot | undefined;
  set(ownerId: string, day: string, usage: UsageSnapshot): void;
}

export class InMemoryUsageStore implements UsageStore {
  private readonly rows = new Map<string, UsageSnapshot>();

  get(ownerId: string, day: string): UsageSnapshot | undefined {
    const row = this.rows.get(`${ownerId}\u0000${day}`);
    return row ? { ...row } : undefined;
  }

  set(ownerId: string, day: string, usage: UsageSnapshot): void {
    this.rows.set(`${ownerId}\u0000${day}`, { ...usage });
  }
}

export interface DayUsage {
  day: string;
  tokens: number;
  cost: number;
}

export interface BackgroundUsage {
  day: string;
  tokens: number;
}

export interface GovernanceOptions {
  policy?: Partial<GovernancePolicy>;
  sink?: AuditSink;
  usageStore?: UsageStore;
  now?: () => number;
}

export class TurnBlockedError extends Error {
  constructor(
    readonly reason: GovernanceBlockReason,
    readonly detail: string,
  ) {
    super(`Turn blocked: ${reason} (${detail})`);
    this.name = "TurnBlockedError";
  }
}

/**
 * Budget, pause switch and audit trail. Small on purpose: it does not call the model or the
 * store, it only answers "may this turn start?" and records what happened.
 */
export class Governance {
  private current: GovernancePolicy;
  private readonly sink: AuditSink;
  private readonly usageStore: UsageStore | undefined;
  private readonly now: () => number;
  private readonly days = new Map<string, DayUsage>();
  private readonly backgroundDays = new Map<string, BackgroundUsage>();

  constructor(options: GovernanceOptions = {}) {
    this.current = { ...DEFAULT_GOVERNANCE_POLICY, ...options.policy };
    this.sink = options.sink ?? new MemoryAuditSink();
    this.usageStore = options.usageStore;
    this.now = options.now ?? Date.now;
  }

  get policy(): Readonly<GovernancePolicy> {
    return { ...this.current };
  }

  update(policy: Partial<GovernancePolicy>): void {
    this.current = { ...this.current, ...policy };
    this.record({
      type: "governance.policy_changed",
      detail: `policy updated: ${Object.keys(policy).join(", ")}`,
      data: { ...policy },
    });
  }

  pause(reason = "paused by the operator"): void {
    this.current = { ...this.current, paused: true };
    this.record({ type: "governance.paused", detail: reason });
  }

  resume(): void {
    this.current = { ...this.current, paused: false };
    this.record({ type: "governance.resumed", detail: "resumed" });
  }

  /** Checks the per-turn and daily budgets before a model call. */
  canStart(scope: { ownerId: string }, estimate: { inputTokens: number }): GovernanceDecision {
    const policy = this.current;
    if (policy.paused) {
      return { allowed: false, reason: "paused", detail: "the companion is paused" };
    }
    if (policy.maxInputTokensPerTurn > 0 && estimate.inputTokens > policy.maxInputTokensPerTurn) {
      return {
        allowed: false,
        reason: "turn_input_budget",
        detail: `${estimate.inputTokens} > ${policy.maxInputTokensPerTurn} input tokens`,
      };
    }
    const expectedOutput = policy.expectedOutputTokens;
    if (policy.maxOutputTokensPerTurn > 0 && expectedOutput > policy.maxOutputTokensPerTurn) {
      return {
        allowed: false,
        reason: "turn_output_budget",
        detail: `${expectedOutput} > ${policy.maxOutputTokensPerTurn} output tokens`,
      };
    }
    const usage = this.usageFor(scope.ownerId);
    if (
      policy.maxTokensPerDay > 0 &&
      usage.tokens + estimate.inputTokens + expectedOutput > policy.maxTokensPerDay
    ) {
      return {
        allowed: false,
        reason: "day_token_budget",
        detail: `${usage.tokens + estimate.inputTokens + expectedOutput} > ${policy.maxTokensPerDay} tokens today`,
      };
    }
    if (policy.maxCostPerDay > 0) {
      const projected =
        usage.cost + this.estimateCost({ inputTokens: estimate.inputTokens, outputTokens: expectedOutput });
      if (projected > policy.maxCostPerDay) {
        return {
          allowed: false,
          reason: "day_cost_budget",
          detail: `${projected} > ${policy.maxCostPerDay} cost today`,
        };
      }
    }
    return { allowed: true };
  }

  /**
   * The gate for background work (conversation summaries). It does not consume the user's
   * per-turn budget; it has its own daily cap so a long conversation cannot quietly burn
   * the whole allowance.
   */
  canStartBackground(ownerId: string, inputTokens: number): GovernanceDecision {
    const policy = this.current;
    if (policy.paused) {
      return { allowed: false, reason: "paused", detail: "the companion is paused" };
    }
    if (policy.maxBackgroundTokensPerDay > 0) {
      const usage = this.backgroundUsageFor(ownerId);
      const projected = usage.tokens + inputTokens + policy.expectedOutputTokens;
      if (projected > policy.maxBackgroundTokensPerDay) {
        return {
          allowed: false,
          reason: "background_token_budget",
          detail: `${projected} > ${policy.maxBackgroundTokensPerDay} background tokens today`,
        };
      }
    }
    return { allowed: true };
  }

  /** Records a finished turn and returns its estimated cost. */
  recordTurn(scope: { ownerId: string; companionId: string }, usage: TurnUsage): number {
    const cost = this.estimateCost(usage);
    const current = this.usageFor(scope.ownerId);
    const day = current.day;
    const next: DayUsage = {
      day,
      tokens: current.tokens + usage.inputTokens + usage.outputTokens,
      cost: current.cost + cost,
    };
    this.days.set(scope.ownerId, next);
    this.usageStore?.set(scope.ownerId, day, { tokens: next.tokens, cost: next.cost });
    this.record({
      type: "turn.completed",
      ownerId: scope.ownerId,
      companionId: scope.companionId,
      detail: `turn completed in ${usage.latencyMs} ms`,
      data: { ...usage, cost },
    });
    return cost;
  }

  /** Records a finished background job (summary) against its own daily counter. */
  recordBackground(scope: { ownerId: string; companionId: string }, usage: TurnUsage): void {
    const current = this.backgroundUsageFor(scope.ownerId);
    this.backgroundDays.set(scope.ownerId, {
      day: current.day,
      tokens: current.tokens + usage.inputTokens + usage.outputTokens,
    });
    this.record({
      type: "summary.completed",
      ownerId: scope.ownerId,
      companionId: scope.companionId,
      detail: `summary completed in ${usage.latencyMs} ms`,
      data: { ...usage },
    });
  }

  recordBackgroundBlocked(
    scope: { ownerId: string; companionId: string },
    reason: GovernanceBlockReason,
    detail: string,
  ): void {
    this.record({
      type: "summary.blocked",
      ownerId: scope.ownerId,
      companionId: scope.companionId,
      detail: `${reason}: ${detail}`,
    });
  }

  recordBlocked(
    scope: { ownerId: string; companionId: string },
    reason: GovernanceBlockReason,
    detail: string,
  ): void {
    this.record({
      type: "turn.blocked",
      ownerId: scope.ownerId,
      companionId: scope.companionId,
      detail: `${reason}: ${detail}`,
    });
  }

  usageFor(ownerId: string): DayUsage {
    const day = this.dayKey();
    const cached = this.days.get(ownerId);
    if (cached && cached.day === day) {
      return { ...cached };
    }
    const stored = this.usageStore?.get(ownerId, day);
    const usage: DayUsage = stored
      ? { day, tokens: stored.tokens, cost: stored.cost }
      : { day, tokens: 0, cost: 0 };
    this.days.set(ownerId, usage);
    return { ...usage };
  }

  backgroundUsageFor(ownerId: string): BackgroundUsage {
    const day = this.dayKey();
    const current = this.backgroundDays.get(ownerId);
    return current && current.day === day ? { ...current } : { day, tokens: 0 };
  }

  estimateCost(usage: TokenUsage): number {
    const policy = this.current;
    return (
      (usage.inputTokens / 1_000_000) * policy.pricePerMillionInputTokens +
      (usage.outputTokens / 1_000_000) * policy.pricePerMillionOutputTokens
    );
  }

  audit(): AuditEntry[] {
    return this.sink instanceof MemoryAuditSink ? this.sink.list() : [];
  }

  snapshot(ownerId: string): {
    policy: GovernancePolicy;
    usage: DayUsage;
  } {
    return { policy: this.policy, usage: this.usageFor(ownerId) };
  }

  private record(entry: Omit<AuditEntry, "id" | "at">): void {
    const full: AuditEntry = { ...entry, id: randomUUID(), at: this.now() };
    try {
      void this.sink.append(full);
    } catch {
      // Auditing must never break a turn.
    }
  }

  private dayKey(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.current.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(this.now()));
  }
}

/** Cheap token estimate: CJK characters count as one, everything else as a quarter. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export function estimateRequestTokens(parts: { systemPrompt: string; history: string[]; userText: string }): number {
  return (
    estimateTokens(parts.systemPrompt) +
    parts.history.reduce((total, text) => total + estimateTokens(text), 0) +
    estimateTokens(parts.userText)
  );
}
