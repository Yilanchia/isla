import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CompanionRuntime, type ConversationScope } from "@isla/core";
import { REI_PROFILE } from "@isla/personas";
import { describeProvider, providerFromEnv } from "@isla/providers";
import { openSqliteStorage } from "@isla/store-sqlite";

const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_PATH = process.env.ISLA_DATA_PATH ?? "./data/isla.sqlite";
const HTTP_TOKEN = process.env.ISLA_HTTP_TOKEN ?? "";
const OWNER_ID = process.env.ISLA_OWNER_ID ?? "owner";
const COMPANION_ID = process.env.ISLA_COMPANION_ID ?? "rei";
const TURN_TIMEOUT_MS = Number(process.env.ISLA_TURN_TIMEOUT_MS ?? 90_000);
const MAX_BODY = 1_000_000;

mkdirSync(dirname(DATA_PATH), { recursive: true });
const storage = openSqliteStorage({ path: DATA_PATH });

const runtime = new CompanionRuntime({
  storage,
  provider: providerFromEnv(),
  profiles: {
    get: (id) => (id === COMPANION_ID ? Promise.resolve(REI_PROFILE) : Promise.resolve(undefined)),
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
    sendJson(response, 200, { ok: true, provider: providerName, companion: REI_PROFILE.name, storage: DATA_PATH });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/state") {
    const umo = url.searchParams.get("umo") ?? "default";
    const scope = scopeOf(umo);
    sendJson(response, 200, {
      umo,
      companion: { id: COMPANION_ID, name: REI_PROFILE.name, identity: REI_PROFILE.identity },
      emotion: runtime.getEmotion(OWNER_ID, COMPANION_ID),
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
        debug: result.debug,
      });
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

server.listen(PORT, HOST, () => {
  console.log(`isla qq-service on http://${HOST}:${PORT}`);
  console.log(`companion: ${REI_PROFILE.name}  provider: ${providerName}`);
  console.log(`data: ${DATA_PATH}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    storage.close();
    server.close(() => process.exit(0));
  });
}
