import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
const OWNER_ID = "local";
const CONVERSATION_ID = "main";
const COMPANION_ID = DEFAULT_COMPANION_ID;
const DB_PATH =
  process.env.ISLA_DATA_PATH ?? fileURLToPath(new URL("../data/isla.sqlite", import.meta.url));
const INDEX_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));

mkdirSync(dirname(DB_PATH), { recursive: true });
const storage = openSqliteStorage({ path: DB_PATH });

const scope: ConversationScope = {
  ownerId: OWNER_ID,
  companionId: COMPANION_ID,
  conversationId: CONVERSATION_ID,
};

// The demo reuses the built-in sample persona. A real host loads its own profiles.
const PROFILE = DEFAULT_COMPANION_PROFILE;

// Demo budgets. Prices are illustrative, not a quote from any provider.
const governance = new Governance({
  policy: {
    maxInputTokensPerTurn: 12_000,
    maxTokensPerDay: 200_000,
    pricePerMillionInputTokens: 2,
    pricePerMillionOutputTokens: 8,
    expectedOutputTokens: 512,
    timezone: "Asia/Shanghai",
  },
});

const runtime = new CompanionRuntime({
  storage,
  governance,
  provider: providerFromEnv(),
  profiles: {
    get: (id) =>
      id === COMPANION_ID ? Promise.resolve(PROFILE) : Promise.resolve(undefined),
  },
});

const providerName = describeProvider(runtime.provider);

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error(error);
    sendJson(response, 500, { error: "internal_error" });
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await readFile(INDEX_PATH, "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      provider: providerName,
      companion: PROFILE.name,
      storage: DB_PATH,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/state") {
    sendJson(response, 200, {
      companion: {
        id: COMPANION_ID,
        name: PROFILE.name,
        identity: PROFILE.identity,
      },
      provider: providerName,
      emotion: runtime.getEmotion(OWNER_ID, COMPANION_ID),
      governance: governance.snapshot(OWNER_ID),
      audit: governance.audit().slice(-20),
      memories: storage.memory
        .list({ ownerId: OWNER_ID, companionId: COMPANION_ID })
        .filter((record) => record.validTo === undefined)
        .slice(-50)
        .reverse(),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/messages") {
    sendJson(response, 200, {
      messages: storage.history.recentMessages(scope, 100),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat") {
    const body = await readJson(request);
    const raw = typeof body.text === "string" ? body.text : Array.isArray(body.text) ? body.text : "";
    const texts = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : raw.trim()
        ? [raw]
        : [];
    if (texts.length === 0) {
      sendJson(response, 400, { error: "empty_message" });
      return;
    }
    try {
      const result = await runtime.handleMessage({
        ownerId: OWNER_ID,
        companionId: COMPANION_ID,
        conversationId: CONVERSATION_ID,
        channel: "platform",
        text: texts,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      });
      sendJson(response, 200, result);
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
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/governance") {
    const body = await readJson(request);
    if (typeof body.paused === "boolean") {
      if (body.paused) {
        governance.pause("paused from the demo UI");
      } else {
        governance.resume();
      }
    }
    sendJson(response, 200, governance.snapshot(OWNER_ID));
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/v1/memories/")) {
    const id = decodeURIComponent(url.pathname.slice("/v1/memories/".length));
    const removed = storage.memory.remove(id);
    sendJson(response, removed ? 200 : 404, { removed });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

server.listen(PORT, () => {
  console.log(`Isla is awake at http://127.0.0.1:${PORT}`);
  console.log(`companion: ${PROFILE.name} (custom persona)`);
  console.log(`provider:  ${providerName}`);
  console.log(`data:      ${DB_PATH}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    storage.close();
    server.close(() => process.exit(0));
  });
}
