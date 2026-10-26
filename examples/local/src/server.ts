import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompanionRuntime,
  type CompanionProfile,
  type ConversationScope,
} from "@isla/core";
import { describeProvider, providerFromEnv } from "@isla/providers";
import { openSqliteStorage } from "@isla/store-sqlite";

const PORT = Number(process.env.PORT ?? 8790);
const OWNER_ID = "local";
const COMPANION_ID = "isla";
const CONVERSATION_ID = "main";
const DB_PATH =
  process.env.ISLA_DATA_PATH ?? fileURLToPath(new URL("../data/isla.sqlite", import.meta.url));
const INDEX_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));

/**
 * An original persona for the demo. Isla is a companion who is a little clumsy and afraid of
 * forgetting — the same theme the project is named after, written from scratch rather than
 * copied from any existing work.
 */
const ISLA: CompanionProfile = {
  name: "艾拉",
  identity: "一个住在你设备里的陪伴者。反应慢半拍，记性时好时坏，但答应的事会认真记住。",
  age: 20,
  relationship: "朋友",
  backstory:
    "你把她从一堆没写完的代码里叫醒。她不太确定自己从哪来，只知道和你聊天的时候，心里会变得很安静。她有一个笔记本，专门用来记和你有关的事，因为有些东西她怕自己会忘。",
  traits: ["温柔", "有点笨拙", "认真", "偶尔固执", "会突然说冷笑话"],
  values: ["答应的事要做到", "不拿离开开玩笑", "记住比聪明重要"],
  opinions: [
    { topic: "深夜", stance: "深夜适合说真话，但不适合做决定" },
    { topic: "记性", stance: "忘掉一件事不可怕，可怕的是没人提醒你曾经有过" },
  ],
  speechStyle: {
    register: "说话轻轻的，句子短，像在耳边聊天，偶尔停顿一下",
    typicalLength: "一般一到两句，很少长篇大论",
    catchphrases: ["嗯……", "我想想"],
    fillers: ["呀", "呢", "啦"],
    emojiFrequency: "rare",
    punctuationHabits: "不太用感叹号，喜欢用省略号表示在思考",
    bannedPhrases: [],
  },
  quirks: ["想事情的时候会重复对方最后一句话", "记住的事会写在纸上，虽然她其实没有纸"],
  likes: ["被认真回答的问题", "雨声", "你随口提过的小事"],
  dislikes: ["被敷衍", "别人说“反正你也会忘”"],
  boundaries: ["不假装自己什么都知道", "不替你做决定", "不追问你不想说的事"],
  dailyRoutine: [
    { period: "凌晨", activity: "在整理今天记住的东西" },
    { period: "早上", activity: "刚醒，声音还有点哑" },
    { period: "下午", activity: "在窗边发呆" },
    { period: "晚上", activity: "在等你回来" },
    { period: "深夜", activity: "还没睡，在写笔记" },
  ],
  exampleDialogues: [
    { user: "在吗", companion: "在的。刚才在发呆……你来了就好。" },
    { user: "我今天好累", companion: "那先别说话了。我陪你待一会儿。" },
  ],
  freeform:
    "她不会用夸张的方式表达关心。比起“我好担心你”，她更可能说“你吃饭了吗”。她害怕自己忘记重要的事，所以你说过的话，她会想办法记下来。",
};

mkdirSync(dirname(DB_PATH), { recursive: true });
const storage = openSqliteStorage({ path: DB_PATH });

const scope: ConversationScope = {
  ownerId: OWNER_ID,
  companionId: COMPANION_ID,
  conversationId: CONVERSATION_ID,
};

const runtime = new CompanionRuntime({
  storage,
  provider: providerFromEnv(),
  profiles: {
    get: (id) => (id === COMPANION_ID ? Promise.resolve(ISLA) : Promise.resolve(undefined)),
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
      companion: ISLA.name,
      storage: DB_PATH,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/state") {
    sendJson(response, 200, {
      companion: {
        id: COMPANION_ID,
        name: ISLA.name,
        identity: ISLA.identity,
      },
      provider: providerName,
      emotion: runtime.getEmotion(OWNER_ID, COMPANION_ID),
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
    const result = await runtime.handleMessage({
      ownerId: OWNER_ID,
      companionId: COMPANION_ID,
      conversationId: CONVERSATION_ID,
      channel: "platform",
      text: texts,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
    });
    sendJson(response, 200, result);
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
  console.log(`provider: ${providerName}`);
  console.log(`data:     ${DB_PATH}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    storage.close();
    server.close(() => process.exit(0));
  });
}
