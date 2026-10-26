import { randomUUID } from "node:crypto";
import type {
  MemoryCandidate,
  MemoryRecord,
  MemoryType,
  RetrievedMemory,
} from "./types.js";

const DEFAULT_LIMIT = 8;
const DEFAULT_HALF_LIFE_MS = 1000 * 60 * 60 * 24 * 30;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase().trim();
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.flatMap((token) => {
    if (/^[\u3400-\u9fff]+$/u.test(token)) {
      return Array.from(token);
    }
    return [token];
  });
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (const character of token) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hashedEmbedding(value: string, dimensions = 128): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of tokenize(value)) {
    const hash = hashToken(token);
    const index = hash % dimensions;
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return norm === 0 ? vector : vector.map((item) => item / norm);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return clamp(dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)), -1, 1);
}

function keywordOverlap(query: string, content: string): number {
  const queryTokens = new Set(tokenize(query));
  const contentTokens = new Set(tokenize(content));
  if (queryTokens.size === 0 || contentTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / queryTokens.size;
}

function recencyScore(ageMs: number, halfLifeMs: number): number {
  return Math.exp((-Math.LN2 * Math.max(0, ageMs)) / halfLifeMs);
}

function halfLifeFor(type: MemoryType): number {
  if (type === "episode") {
    return DEFAULT_HALF_LIFE_MS / 2;
  }
  if (type === "self" || type === "relationship") {
    return DEFAULT_HALF_LIFE_MS * 8;
  }
  return DEFAULT_HALF_LIFE_MS;
}

function relationshipRelevance(type: MemoryType): number {
  return type === "relationship" || type === "self" ? 1 : 0.35;
}

function normalizeMemoryContent(content: string): string {
  return content.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}

function normalizeMemoryKey(key: string | undefined): string | undefined {
  const normalized = key?.trim().toLocaleLowerCase();
  return normalized || undefined;
}

export interface MemorySearchOptions {
  ownerId?: string;
  companionId?: string;
  limit?: number;
  now?: number;
  embedding?: number[];
  /** MMR relevance weight. Lower values prefer more diverse memories. */
  diversityLambda?: number;
}

/**
 * The subset of the memory store the runtime depends on. Implement it to back memories
 * with SQLite, Postgres or a remote service without touching the runtime.
 */
export interface MemoryRepository {
  list(options?: MemorySearchOptions): MemoryRecord[];
  add(
    candidate: MemoryCandidate,
    context: { ownerId: string; companionId: string; now?: number },
  ): MemoryRecord;
  setEmbedding(id: string, embedding: number[]): boolean;
  search(query: string, options?: MemorySearchOptions): RetrievedMemory[];
  takeUpdatedRecords(): MemoryRecord[];
}

export class MemoryStore implements MemoryRepository {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly updatedIds = new Set<string>();

  constructor(records: MemoryRecord[] = []) {
    for (const record of records) {
      this.records.set(record.id, {
        ...record,
        sourceMessageIds: [...record.sourceMessageIds],
      });
    }
  }

  add(
    candidate: MemoryCandidate,
    context: { ownerId: string; companionId: string; now?: number },
  ): MemoryRecord {
    const now = context.now ?? Date.now();
    const normalizedContent = normalizeMemoryContent(candidate.content);
    const candidateKey = normalizeMemoryKey(candidate.key);
    const scopedRecords = this.list({
      ownerId: context.ownerId,
      companionId: context.companionId,
    });
    const activeRecords = scopedRecords.filter((record) =>
      isActiveAt(record, now),
    );
    const existing = activeRecords.find(
      (record) =>
        record.type === candidate.type &&
        normalizeMemoryContent(record.content) === normalizedContent,
    );
    if (existing) {
      existing.importance = Math.max(
        existing.importance,
        clamp(candidate.importance ?? 0.5),
      );
      existing.confidence = Math.max(
        existing.confidence,
        clamp(candidate.confidence ?? 0.7),
      );
      existing.lastAccessedAt = now;
      existing.sourceMessageIds = [
        ...new Set([
          ...existing.sourceMessageIds,
          ...(candidate.sourceMessageIds ?? []),
        ]),
      ];
      if (candidateKey) {
        existing.key = candidateKey;
      }
      if (candidate.origin) {
        existing.origin = candidate.origin;
      }
      if (candidate.embedding) {
        existing.embedding = candidate.embedding;
      }
      this.updatedIds.add(existing.id);
      return this.get(existing.id) ?? existing;
    }
    const supersededIds = new Set(candidate.supersedes ?? []);
    for (const record of activeRecords) {
      const sameLogicalKey =
        candidateKey !== undefined && record.key === candidateKey;
      if (sameLogicalKey || supersededIds.has(record.id)) {
        record.validTo = Math.min(
          record.validTo ?? Number.POSITIVE_INFINITY,
          now,
        );
        this.updatedIds.add(record.id);
      }
    }
    const record: MemoryRecord = {
      id: randomUUID(),
      ownerId: context.ownerId,
      companionId: context.companionId,
      type: candidate.type,
      content: candidate.content.trim(),
      importance: clamp(candidate.importance ?? 0.5),
      confidence: clamp(candidate.confidence ?? 0.7),
      ...(candidateKey ? { key: candidateKey } : {}),
      ...(candidate.origin ? { origin: candidate.origin } : {}),
      createdAt: now,
      lastAccessedAt: now,
      validFrom: now,
      sourceMessageIds: candidate.sourceMessageIds ?? [],
      ...(candidate.embedding ? { embedding: candidate.embedding } : {}),
    };
    this.records.set(record.id, record);
    return record;
  }

  /** Returns records changed by add() so persistence can close superseded versions. */
  takeUpdatedRecords(): MemoryRecord[] {
    const records = [...this.updatedIds]
      .map((id) => this.records.get(id))
      .filter((record): record is MemoryRecord => Boolean(record))
      .map((record) => ({
        ...record,
        sourceMessageIds: [...record.sourceMessageIds],
      }));
    this.updatedIds.clear();
    return records;
  }

  setEmbedding(id: string, embedding: number[]): boolean {
    const record = this.records.get(id);
    if (
      !record ||
      embedding.length === 0 ||
      embedding.some((value) => !Number.isFinite(value))
    ) {
      return false;
    }
    record.embedding = [...embedding];
    this.updatedIds.add(id);
    return true;
  }

  list(options: MemorySearchOptions = {}): MemoryRecord[] {
    return [...this.records.values()].filter((record) => {
      if (options.ownerId && record.ownerId !== options.ownerId) {
        return false;
      }
      if (options.companionId && record.companionId !== options.companionId) {
        return false;
      }
      return true;
    });
  }

  get(id: string): MemoryRecord | undefined {
    const record = this.records.get(id);
    return record
      ? { ...record, sourceMessageIds: [...record.sourceMessageIds] }
      : undefined;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        MemoryRecord,
        | "type"
        | "content"
        | "importance"
        | "confidence"
        | "validTo"
        | "key"
        | "embedding"
      >
    >,
  ): MemoryRecord | undefined {
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }
    if (patch.type !== undefined) {
      record.type = patch.type;
    }
    if (patch.content !== undefined) {
      record.content = patch.content.trim();
      record.embedding = patch.embedding ?? hashedEmbedding(record.content);
    } else if (patch.embedding !== undefined) {
      record.embedding = [...patch.embedding];
    }
    if (patch.importance !== undefined) {
      record.importance = clamp(patch.importance);
    }
    if (patch.confidence !== undefined) {
      record.confidence = clamp(patch.confidence);
    }
    if (patch.validTo !== undefined) {
      record.validTo = patch.validTo;
    }
    if (patch.key !== undefined) {
      const key = normalizeMemoryKey(patch.key);
      if (key) {
        record.key = key;
      } else {
        delete record.key;
      }
    }
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.records.delete(id);
  }

  search(query: string, options: MemorySearchOptions = {}): RetrievedMemory[] {
    const now = options.now ?? Date.now();
    const queryEmbedding = options.embedding ?? hashedEmbedding(query);
    const scored = this.list(options)
      .filter(
        (record) =>
          record.validFrom <= now &&
          (record.validTo === undefined || now < record.validTo),
      )
      .map((record) => {
        const semantic = cosineSimilarity(
          queryEmbedding,
          record.embedding ?? hashedEmbedding(record.content),
        );
        const normalizedSemantic = clamp((semantic + 1) / 2);
        const keyword = keywordOverlap(query, record.content);
        const recency = recencyScore(
          now - record.lastAccessedAt,
          halfLifeFor(record.type),
        );
        const importance = clamp(record.importance);
        const confidence = clamp(record.confidence);
        const relationship = relationshipRelevance(record.type);
        const score =
          0.4 * normalizedSemantic +
          0.15 * keyword +
          0.15 * recency +
          0.1 * importance +
          0.1 * confidence +
          0.1 * relationship;
        return {
          ...record,
          embeddingForRanking:
            record.embedding ?? hashedEmbedding(record.content),
          score,
          components: {
            semantic: normalizedSemantic,
            keyword,
            recency,
            importance,
            confidence,
            relationshipRelevance: relationship,
          },
        };
      });

    const result = selectWithMmr(
      scored,
      options.limit ?? DEFAULT_LIMIT,
      options.diversityLambda ?? 0.7,
    );
    for (const memory of result) {
      const stored = this.records.get(memory.id);
      if (stored) {
        stored.lastAccessedAt = now;
      }
    }
    return result.map((memory) => {
      const { embeddingForRanking: _embeddingForRanking, ...retrieved } =
        memory;
      return { ...retrieved, lastAccessedAt: now };
    });
  }
}

function isActiveAt(record: MemoryRecord, now: number): boolean {
  return (
    record.validFrom <= now &&
    (record.validTo === undefined || now < record.validTo)
  );
}

function selectWithMmr<
  T extends {
    id: string;
    score: number;
    embeddingForRanking?: number[] | undefined;
  },
>(items: T[], limit: number, lambda: number): T[] {
  const selected: T[] = [];
  const remaining = [...items];
  const boundedLambda = clamp(lambda);
  while (remaining.length > 0 && selected.length < Math.max(0, limit)) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (!candidate) continue;
      const redundancy = selected.reduce((maximum, previous) => {
        if (!candidate.embeddingForRanking || !previous.embeddingForRanking)
          return maximum;
        return Math.max(
          maximum,
          (cosineSimilarity(
            candidate.embeddingForRanking,
            previous.embeddingForRanking,
          ) +
            1) /
            2,
        );
      }, 0);
      const mmr =
        boundedLambda * candidate.score - (1 - boundedLambda) * redundancy;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIndex = index;
      }
    }
    const [winner] = remaining.splice(bestIndex, 1);
    if (winner) selected.push(winner);
  }
  return selected;
}
