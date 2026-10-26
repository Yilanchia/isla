import { randomUUID } from "node:crypto";
import type { ChannelName } from "./types.js";

export interface ProactiveJob {
  id: string;
  ownerId: string;
  companionId: string;
  conversationId: string;
  channel: ChannelName;
  text: string;
  dueAt: number;
  expiresAt?: number;
  dedupeKey?: string;
  status: "pending" | "sent" | "cancelled" | "expired";
  createdAt: number;
  /** When the message was actually delivered; used by the daily cap and the cooldown. */
  sentAt?: number;
}

export type ProactiveJobInput = Omit<ProactiveJob, "id" | "status" | "createdAt" | "sentAt">;

/** Persistence hook for jobs, so a restart does not lose the queue. */
export interface ProactiveStore {
  list(ownerId?: string): ProactiveJob[];
  save(job: ProactiveJob): void;
}

export interface QuietHours {
  /** Inclusive start, `HH:MM` in the policy timezone. */
  start: string;
  /** Exclusive end, `HH:MM` in the policy timezone. May be smaller than start (crosses midnight). */
  end: string;
}

/**
 * How a companion is allowed to reach out unprompted.
 *
 * The defaults are deliberately conservative: off, one message a day, four hours apart.
 * A host that wants more has to say so explicitly.
 */
export interface ProactivePolicy {
  /** Master switch. When false, `due()` always returns an empty list. */
  enabled: boolean;
  quietHours?: QuietHours;
  /** Maximum delivered messages per local calendar day. */
  maxPerDay: number;
  /** Minimum gap between two delivered messages. */
  minGapMs: number;
  timezone?: string;
}

export const DEFAULT_PROACTIVE_POLICY: ProactivePolicy = {
  enabled: false,
  maxPerDay: 1,
  minGapMs: 4 * 60 * 60 * 1000,
};

export interface ProactiveSchedulerOptions {
  policy?: Partial<ProactivePolicy>;
  store?: ProactiveStore;
  logger?: { warn(message: string, error?: unknown): void };
}

/**
 * Time-based queue with deduplication and a delivery policy.
 *
 * `due()` is a gate, not a sender: it answers "is it allowed to send right now?".
 * The caller still has to deliver the message and call `markSent()`.
 */
export class ProactiveScheduler {
  private readonly jobs = new Map<string, ProactiveJob>();
  private readonly policy: ProactivePolicy;
  private readonly store: ProactiveStore | undefined;
  private readonly logger: { warn(message: string, error?: unknown): void };

  constructor(options: ProactiveSchedulerOptions = {}) {
    this.policy = { ...DEFAULT_PROACTIVE_POLICY, ...options.policy };
    this.store = options.store;
    this.logger = options.logger ?? { warn: (message, error) => console.warn(message, error) };
    for (const job of this.store?.list() ?? []) {
      this.jobs.set(job.id, { ...job });
    }
  }

  get currentPolicy(): Readonly<ProactivePolicy> {
    return { ...this.policy };
  }

  add(input: ProactiveJobInput): ProactiveJob {
    if (input.dedupeKey) {
      const duplicate = [...this.jobs.values()].find(
        (job) => job.status === "pending" && job.dedupeKey === input.dedupeKey,
      );
      if (duplicate) {
        return duplicate;
      }
    }
    const job: ProactiveJob = {
      ...input,
      id: randomUUID(),
      status: "pending",
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.persist(job);
    return job;
  }

  get(id: string): ProactiveJob | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  list(ownerId?: string): ProactiveJob[] {
    return [...this.jobs.values()]
      .filter((job) => !ownerId || job.ownerId === ownerId)
      .map((job) => ({ ...job }));
  }

  /** Jobs that are due *and* allowed by the policy. Expired jobs are marked and skipped. */
  due(now = Date.now()): ProactiveJob[] {
    if (!this.policy.enabled || this.isQuietHour(now)) {
      return [];
    }
    if (this.sentOnDay(now) >= this.policy.maxPerDay) {
      return [];
    }
    const lastSentAt = this.lastSentAt();
    if (lastSentAt !== undefined && now - lastSentAt < this.policy.minGapMs) {
      return [];
    }
    return [...this.jobs.values()].filter((job) => {
      if (job.status !== "pending" || job.dueAt > now) {
        return false;
      }
      if (job.expiresAt !== undefined && job.expiresAt < now) {
        job.status = "expired";
        this.persist(job);
        return false;
      }
      return true;
    });
  }

  markSent(id: string, now = Date.now()): void {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Unknown proactive job: ${id}`);
    }
    job.status = "sent";
    job.sentAt = now;
    this.persist(job);
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Unknown proactive job: ${id}`);
    }
    job.status = "cancelled";
    this.persist(job);
  }

  private persist(job: ProactiveJob): void {
    try {
      this.store?.save({ ...job });
    } catch (error: unknown) {
      this.logger.warn("failed to persist proactive job", error);
    }
  }

  private lastSentAt(): number | undefined {
    let latest: number | undefined;
    for (const job of this.jobs.values()) {
      if (job.sentAt !== undefined && (latest === undefined || job.sentAt > latest)) {
        latest = job.sentAt;
      }
    }
    return latest;
  }

  private sentOnDay(now: number): number {
    const day = this.localDayKey(now);
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.sentAt !== undefined && this.localDayKey(job.sentAt) === day) {
        count += 1;
      }
    }
    return count;
  }

  private isQuietHour(now: number): boolean {
    const quiet = this.policy.quietHours;
    if (!quiet) {
      return false;
    }
    const start = parseClock(quiet.start);
    const end = parseClock(quiet.end);
    if (start === undefined || end === undefined) {
      return false;
    }
    const minutes = this.minutesOfDay(now);
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }

  private localDayKey(timestamp: number): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.policy.timezone ?? "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(timestamp));
  }

  private minutesOfDay(timestamp: number): number {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: this.policy.timezone ?? "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(timestamp));
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    return (hour % 24) * 60 + minute;
  }
}

function parseClock(value: string): number | undefined {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}
