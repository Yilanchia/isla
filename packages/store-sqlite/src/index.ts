import { DatabaseSync } from "node:sqlite";
import {
  conversationKey,
  MemoryStore,
  type CompanionStorage,
  type ConversationHistorySource,
  type ConversationScope,
  type ConversationSummary,
  type EmotionScope,
  type EmotionState,
  type EmotionStore,
  type MemoryCandidate,
  type MemoryRecord,
  type MemoryRepository,
  type MemorySearchOptions,
  type ProactiveJob,
  type ProactiveStore,
  type RetrievedMemory,
  type UsageSnapshot,
  type UsageStore,
} from "@isla/core";

/**
 * SQLite storage for Isla, built on Node's built-in `node:sqlite` (no native dependency).
 *
 * Memories keep an in-process copy of the store for scoring and MMR, and every write is
 * mirrored to SQLite. Conversations, summaries, emotion and proactive jobs are read and
 * written directly. A companion's memory is small (thousands of rows at most), so this is a
 * good trade for a local-first app; swap in a different `CompanionStorage` for a large server.
 */
export interface SqliteStorage extends CompanionStorage {
  readonly memory: SqliteMemoryStore;
  readonly history: SqliteHistoryStore;
  readonly emotion: SqliteEmotionStore;
  readonly proactive: SqliteProactiveStore;
  readonly usage: SqliteUsageStore;
  /** Closes the underlying database. */
  close(): void;
}

export interface OpenSqliteOptions {
  /** Database file path, or `:memory:` for tests. */
  path: string;
}

export function openSqliteStorage(options: OpenSqliteOptions): SqliteStorage {
  const db = new DatabaseSync(options.path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return {
    memory: new SqliteMemoryStore(db),
    history: new SqliteHistoryStore(db),
    emotion: new SqliteEmotionStore(db),
    proactive: new SqliteProactiveStore(db),
    usage: new SqliteUsageStore(db),
    close: () => db.close(),
  };
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      companion_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      key TEXT,
      origin TEXT,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      source_message_ids TEXT NOT NULL,
      embedding TEXT
    );
    CREATE INDEX IF NOT EXISTS memories_scope ON memories(owner_id, companion_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      companion_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_scope ON messages(owner_id, companion_id, conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS summaries (
      owner_id TEXT NOT NULL,
      companion_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      covered_until INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, companion_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS emotions (
      owner_id TEXT NOT NULL,
      companion_id TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, companion_id)
    );

    CREATE TABLE IF NOT EXISTS proactive_jobs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      companion_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      text TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      expires_at INTEGER,
      dedupe_key TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS proactive_owner ON proactive_jobs(owner_id, status, due_at);

    CREATE TABLE IF NOT EXISTS usage (
      owner_id TEXT NOT NULL,
      day TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      PRIMARY KEY (owner_id, day)
    );
  `);
}

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function number(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToMemory(row: Row): MemoryRecord {
  const record: MemoryRecord = {
    id: text(row.id),
    ownerId: text(row.owner_id),
    companionId: text(row.companion_id),
    type: text(row.type) as MemoryRecord["type"],
    content: text(row.content),
    importance: number(row.importance),
    confidence: number(row.confidence),
    createdAt: number(row.created_at),
    lastAccessedAt: number(row.last_accessed_at),
    validFrom: number(row.valid_from),
    sourceMessageIds: parseJson<string[]>(row.source_message_ids, []),
  };
  if (row.key !== null && row.key !== undefined) record.key = text(row.key);
  if (row.origin !== null && row.origin !== undefined) {
    record.origin = text(row.origin) as MemoryRecord["origin"];
  }
  if (row.valid_to !== null && row.valid_to !== undefined) record.validTo = number(row.valid_to);
  const embedding = parseJson<number[]>(row.embedding, []);
  if (embedding.length > 0) record.embedding = embedding;
  return record;
}

export class SqliteMemoryStore implements MemoryRepository {
  private readonly memory: MemoryStore;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    const rows = db.prepare("SELECT * FROM memories").all() as Row[];
    this.memory = new MemoryStore(rows.map(rowToMemory));
  }

  list(options: MemorySearchOptions = {}): MemoryRecord[] {
    return this.memory.list(options);
  }

  get(id: string): MemoryRecord | undefined {
    return this.memory.get(id);
  }

  add(
    candidate: MemoryCandidate,
    context: { ownerId: string; companionId: string; now?: number },
  ): MemoryRecord {
    const record = this.memory.add(candidate, context);
    this.upsert(record);
    return record;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        MemoryRecord,
        "type" | "content" | "importance" | "confidence" | "validTo" | "key" | "embedding"
      >
    >,
  ): MemoryRecord | undefined {
    const record = this.memory.update(id, patch);
    if (record) this.upsert(record);
    return record;
  }

  remove(id: string): boolean {
    const removed = this.memory.remove(id);
    if (removed) {
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    }
    return removed;
  }

  setEmbedding(id: string, embedding: number[]): boolean {
    const changed = this.memory.setEmbedding(id, embedding);
    if (changed) {
      const record = this.memory.get(id);
      if (record) this.upsert(record);
    }
    return changed;
  }

  search(query: string, options: MemorySearchOptions = {}): RetrievedMemory[] {
    return this.memory.search(query, options);
  }

  takeUpdatedRecords(): MemoryRecord[] {
    const records = this.memory.takeUpdatedRecords();
    for (const record of records) {
      this.upsert(record);
    }
    return records;
  }

  private upsert(record: MemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO memories
          (id, owner_id, companion_id, type, content, importance, confidence, key, origin,
           created_at, last_accessed_at, valid_from, valid_to, source_message_ids, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           content = excluded.content,
           importance = excluded.importance,
           confidence = excluded.confidence,
           key = excluded.key,
           origin = excluded.origin,
           last_accessed_at = excluded.last_accessed_at,
           valid_to = excluded.valid_to,
           source_message_ids = excluded.source_message_ids,
           embedding = excluded.embedding`,
      )
      .run(
        record.id,
        record.ownerId,
        record.companionId,
        record.type,
        record.content,
        record.importance,
        record.confidence,
        record.key ?? null,
        record.origin ?? null,
        record.createdAt,
        record.lastAccessedAt,
        record.validFrom,
        record.validTo ?? null,
        JSON.stringify(record.sourceMessageIds),
        record.embedding ? JSON.stringify(record.embedding) : null,
      );
  }
}

export class SqliteHistoryStore implements ConversationHistorySource {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Called by the host after a turn to persist the user's messages and the reply bubbles. */
  append(
    scope: ConversationScope,
    message: { id: string; role: "user" | "assistant"; text: string; createdAt: number },
  ): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, owner_id, companion_id, conversation_id, role, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
      )
      .run(
        message.id,
        scope.ownerId,
        scope.companionId,
        scope.conversationId,
        message.role,
        message.text,
        message.createdAt,
      );
  }

  recentMessages(scope: ConversationScope, limit: number): Array<{
    id?: string;
    role: "user" | "assistant";
    text: string;
    createdAt: number;
  }> {
    if (limit <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id, role, text, created_at FROM messages
         WHERE owner_id = ? AND companion_id = ? AND conversation_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(scope.ownerId, scope.companionId, scope.conversationId, limit) as Row[];
    return rows
      .reverse()
      .map((row) => ({
        id: text(row.id),
        role: text(row.role) as "user" | "assistant",
        text: text(row.text),
        createdAt: number(row.created_at),
      }));
  }

  messagesAfter(
    scope: ConversationScope,
    after: number,
    limit: number,
  ): Array<{ id?: string; role: "user" | "assistant"; text: string; createdAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, role, text, created_at FROM messages
         WHERE owner_id = ? AND companion_id = ? AND conversation_id = ? AND created_at > ?
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(scope.ownerId, scope.companionId, scope.conversationId, after, limit) as Row[];
    return rows.map((row) => ({
      id: text(row.id),
      role: text(row.role) as "user" | "assistant",
      text: text(row.text),
      createdAt: number(row.created_at),
    }));
  }

  lastUserMessageAt(scope: ConversationScope): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(created_at) AS latest FROM messages
         WHERE owner_id = ? AND companion_id = ? AND conversation_id = ? AND role = 'user'`,
      )
      .get(scope.ownerId, scope.companionId, scope.conversationId) as Row | undefined;
    const latest = row ? numberOrNull(row.latest) : null;
    return latest === null ? undefined : latest;
  }

  getSummary(scope: ConversationScope): ConversationSummary | undefined {
    const row = this.db
      .prepare(
        `SELECT summary, covered_until, updated_at FROM summaries
         WHERE owner_id = ? AND companion_id = ? AND conversation_id = ?`,
      )
      .get(scope.ownerId, scope.companionId, scope.conversationId) as Row | undefined;
    if (!row) return undefined;
    return {
      summary: text(row.summary),
      coveredUntil: number(row.covered_until),
      updatedAt: number(row.updated_at),
    };
  }

  saveSummary(scope: ConversationScope, summary: ConversationSummary): void {
    this.db
      .prepare(
        `INSERT INTO summaries (owner_id, companion_id, conversation_id, summary, covered_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, companion_id, conversation_id) DO UPDATE SET
           summary = excluded.summary,
           covered_until = excluded.covered_until,
           updated_at = excluded.updated_at`,
      )
      .run(
        scope.ownerId,
        scope.companionId,
        scope.conversationId,
        summary.summary,
        summary.coveredUntil,
        summary.updatedAt,
      );
  }

  /** Deletes a whole conversation (messages + summary). */
  deleteConversation(scope: ConversationScope): void {
    this.db
      .prepare(
        `DELETE FROM messages
         WHERE owner_id = ? AND companion_id = ? AND conversation_id = ?`,
      )
      .run(scope.ownerId, scope.companionId, scope.conversationId);
    this.db
      .prepare(
        `DELETE FROM summaries
         WHERE owner_id = ? AND companion_id = ? AND conversation_id = ?`,
      )
      .run(scope.ownerId, scope.companionId, scope.conversationId);
  }
}

export class SqliteEmotionStore implements EmotionStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(scope: EmotionScope): EmotionState | undefined {
    const row = this.db
      .prepare("SELECT state FROM emotions WHERE owner_id = ? AND companion_id = ?")
      .get(scope.ownerId, scope.companionId) as Row | undefined;
    if (!row) return undefined;
    return parseJson<EmotionState | null>(row.state, null) ?? undefined;
  }

  set(scope: EmotionScope, state: EmotionState): void {
    this.db
      .prepare(
        `INSERT INTO emotions (owner_id, companion_id, state, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id, companion_id) DO UPDATE SET
           state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(scope.ownerId, scope.companionId, JSON.stringify(state), state.updatedAt);
  }

  list(): Array<{ scope: EmotionScope; state: EmotionState }> {
    const rows = this.db
      .prepare("SELECT owner_id, companion_id, state FROM emotions")
      .all() as Row[];
    const result: Array<{ scope: EmotionScope; state: EmotionState }> = [];
    for (const row of rows) {
      const state = parseJson<EmotionState | null>(row.state, null);
      if (state) {
        result.push({
          scope: { ownerId: text(row.owner_id), companionId: text(row.companion_id) },
          state,
        });
      }
    }
    return result;
  }

  delete(scope: EmotionScope): void {
    this.db
      .prepare("DELETE FROM emotions WHERE owner_id = ? AND companion_id = ?")
      .run(scope.ownerId, scope.companionId);
  }
}

export class SqliteProactiveStore implements ProactiveStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(ownerId?: string): ProactiveJob[] {
    const sql = ownerId
      ? "SELECT * FROM proactive_jobs WHERE owner_id = ? ORDER BY due_at ASC"
      : "SELECT * FROM proactive_jobs ORDER BY due_at ASC";
    const rows = (ownerId
      ? this.db.prepare(sql).all(ownerId)
      : this.db.prepare(sql).all()) as Row[];
    return rows.map(rowToJob);
  }

  save(job: ProactiveJob): void {
    this.db
      .prepare(
        `INSERT INTO proactive_jobs
          (id, owner_id, companion_id, conversation_id, channel, text, due_at, expires_at,
           dedupe_key, status, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           due_at = excluded.due_at,
           expires_at = excluded.expires_at,
           dedupe_key = excluded.dedupe_key,
           status = excluded.status,
           sent_at = excluded.sent_at`,
      )
      .run(
        job.id,
        job.ownerId,
        job.companionId,
        job.conversationId,
        job.channel,
        job.text,
        job.dueAt,
        job.expiresAt ?? null,
        job.dedupeKey ?? null,
        job.status,
        job.createdAt,
        job.sentAt ?? null,
      );
  }
}

export class SqliteUsageStore implements UsageStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(ownerId: string, day: string): UsageSnapshot | undefined {
    const row = this.db
      .prepare("SELECT tokens, cost FROM usage WHERE owner_id = ? AND day = ?")
      .get(ownerId, day) as Row | undefined;
    return row ? { tokens: number(row.tokens), cost: number(row.cost) } : undefined;
  }

  set(ownerId: string, day: string, usage: UsageSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO usage (owner_id, day, tokens, cost)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id, day) DO UPDATE SET
           tokens = excluded.tokens,
           cost = excluded.cost`,
      )
      .run(ownerId, day, usage.tokens, usage.cost);
  }
}

function rowToJob(row: Row): ProactiveJob {
  const job: ProactiveJob = {
    id: text(row.id),
    ownerId: text(row.owner_id),
    companionId: text(row.companion_id),
    conversationId: text(row.conversation_id),
    channel: text(row.channel) as ProactiveJob["channel"],
    text: text(row.text),
    dueAt: number(row.due_at),
    status: text(row.status) as ProactiveJob["status"],
    createdAt: number(row.created_at),
  };
  const expiresAt = numberOrNull(row.expires_at);
  if (expiresAt !== null) job.expiresAt = expiresAt;
  const dedupeKey = textOrNull(row.dedupe_key);
  if (dedupeKey !== null) job.dedupeKey = dedupeKey;
  const sentAt = numberOrNull(row.sent_at);
  if (sentAt !== null) job.sentAt = sentAt;
  return job;
}

export { conversationKey };
