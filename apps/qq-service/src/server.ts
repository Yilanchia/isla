import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  CompanionRuntime,
  DEFAULT_COMPANION_ID,
  DEFAULT_COMPANION_PROFILE,
  Governance,
  TurnBlockedError,
  type ConversationScope,
} from "@isla/core";
import { describeProvider, providerFromEnv } from "@isla/providers";
import { openSqliteStorage } from "@isla/store-sqlite";

const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_PATH = process.env.ISLA_DATA_PATH ?? "./data/isla.sqlite";
const HTTP_TOKEN = process.env.ISLA_HTTP_TOKEN ?? "";
const OWNER_ID = process.env.ISLA_OWNER_ID ?? "owner";
const COMPANION_ID = process.env.ISLA_COMPANION_ID ?? DEFAULT_COMPANION_ID;
const TURN_TIMEOUT_MS = Number(process.env.ISLA_TURN_TIMEOUT_MS ?? 90_000);
const MAX_BODY = 1_000_000;

mkdirSync(dirname(DATA_PATH), { recursive: true });
const storage = openSqliteStorage({ path: DATA_PATH });

const governance = new Governance({
  usageStore: storage.usage,
  policy: {
    maxInputTokensPerTurn: Number(process.env.ISLA_MAX_INPUT_TOKENS ?? 12_000),
    maxTokensPerDay: Number(process.env.ISLA_MAX_TOKENS_PER_DAY ?? 200_000),
    maxBackgroundTokensPerDay: Number(process.env.ISLA_MAX_BACKGROUND_TOKENS ?? 50_000),
    pricePerMillionInputTokens: Number(process.env.ISLA_PRICE_IN ?? 0),
    pricePerMillionOutputTokens: Number(process.env.ISLA_PRICE_OUT ?? 0),
    expectedOutputTokens: Number(process.env.ISLA_EXPECTED_OUTPUT_TOKENS ?? 512),
    timezone: process.env.ISLA_TIMEZONE ?? "Asia/Shanghai",
  },
});

const runtime = new CompanionRuntime({
  storage,
  governance,
  provider: providerFromEnv(),
  profiles: {
    get: (id) =>
      id === COMPANION_ID ? Promise.resolve(DEFAULT_COMPANION_PROFILE) : Promise.resolve(undefined),
  },
  turnTimeoutMs: TURN_TIMEOUT_MS,
});

const providerName = describeProvider(runtime.provider);

function scopeOf(conversationId: string): ConversationScope {
  return { ownerId: OWNER_ID, companionId: COMPANION_ID, conversationId };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function authorized(request: IncomingMessage): boolean {
  if (!HTTP_TOKEN) return true;
  return request.headers["x-isla-token"] === HTTP_TOKEN;
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error("[qq-service]", error);
    if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname !== "/health" && !authorized(request)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, provider: providerName, companion: DEFAULT_COMPANION_PROFILE.name, storage: DATA_PATH });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/state") {
    const umo = url.searchParams.get("umo") ?? "default";
    const scope = scopeOf(umo);
    sendJson(response, 200, {
      umo,
      companion: {
        id: COMPANION_ID,
        name: DEFAULT_COMPANION_PROFILE.name,
        identity: DEFAULT_COMPANION_PROFILE.identity,
      },
      emotion: runtime.getEmotion(OWNER_ID, COMPANION_ID),
      governance: governance.snapshot(OWNER_ID),
      memories: storage.memory
        .list({ ownerId: OWNER_ID, companionId: COMPANION_ID })
        .filter((record) => record.validTo === undefined),
      recentMessages: storage.history.recentMessages(scope, 10),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/memories") {
    sendJson(response, 200, {
      memories: storage.memory
        .list({ ownerId: OWNER_ID, companionId: COMPANION_ID })
        .filter((record) => record.validTo === undefined),
    });
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/v1/memories/")) {
    const id = decodeURIComponent(url.pathname.slice("/v1/memories/".length));
    const removed = storage.memory.remove(id);
    sendJson(response, removed ? 200 : 404, { removed });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/turn") {
    const body = await readJson(request);
    const umo = typeof body.umo === "string" && body.umo.trim() ? body.umo.trim() : "";
    if (!umo) {
      sendJson(response, 400, { error: "missing_umo" });
      return;
    }
    const raw = body.texts;
    const texts = (Array.isArray(raw) ? raw : [raw])
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (texts.length === 0) {
      sendJson(response, 400, { error: "empty_message" });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
    try {
      const result = await runtime.handleMessage({
        ownerId: OWNER_ID,
        companionId: COMPANION_ID,
        conversationId: umo,
        channel: "platform",
        text: texts,
        timezone: typeof body.timezone === "string" ? body.timezone : "Asia/Shanghai",
        signal: controller.signal,
      });
      sendJson(response, 200, {
        bubbleMode: "sequential",
        bubbles: result.messages.map((message) => ({ text: message.text, delayMs: message.delayMs })),
        reply: result.reply,
        emotion: result.emotion,
        emotionLabel: result.emotionLabel,
        memoriesUsed: result.memoriesUsed.map((memory) => memory.content),
        trace: result.trace,
        debug: result.debug,
      });
    } catch (error: unknown) {
      if (error instanceof TurnBlockedError) {
        sendJson(response, 429, {
          error: "turn_blocked",
          reason: error.reason,
          detail: error.detail,
        });
        return;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/governance") {
    const body = await readJson(request);
    if (typeof body.paused === "boolean") {
      if (body.paused) {
        governance.pause("paused from the qq service");
      } else {
        governance.resume();
      }
    }
    sendJson(response, 200, governance.snapshot(OWNER_ID));
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

server.listen(PORT, HOST, () => {
  console.log(`isla qq-service on http://${HOST}:${PORT}`);
  console.log(`companion: ${DEFAULT_COMPANION_PROFILE.name}  provider: ${providerName}`);
  console.log(`data: ${DATA_PATH}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    storage.close();
    server.close(() => process.exit(0));
  });
}
