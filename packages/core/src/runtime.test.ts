import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { XIAO_MAN_PROFILE } from "./test-fixtures.js";
import { MemoryStore } from "./memory.js";
import { CompanionRuntime, selectHistory } from "./runtime.js";
import type { ModelProvider, ModelRequest, SummaryRequest } from "./types.js";

describe("CompanionRuntime", () => {
  it("retrieves memory, creates candidates, and updates emotion in one turn", async () => {
    const runtime = new CompanionRuntime({ now: () => 1000 });
    const result = await runtime.handleMessage({
      ownerId: "user-a",
      companionId: "companion",
      conversationId: "conversation-a",
      channel: "platform",
      text: "我今天很开心",
      memoryCandidates: [
        {
          type: "episode",
          content: "用户今天很开心",
          importance: 0.7,
          confidence: 0.9,
        },
      ],
      emotionEvent: {
        delta: { pleasure: 0.5 },
        importance: 0.8,
        reason: "用户分享开心的事情",
      },
    });

    assert.match(result.reply, /我今天很开心/u);
    assert.equal(result.memoriesCreated.length, 1);
    assert.ok(result.emotion.pleasure > 0.1);
    assert.equal(result.provider, "demo");
  });

  it("persists only confident automatic memory candidates", async () => {
    const runtime = new CompanionRuntime({
      now: () => 2000,
      provider: {
        name: "test-provider",
        async generate() {
          return {
            text: "我记住了。",
            memoryCandidates: [
              {
                type: "preference",
                content: "用户喜欢简洁回答",
                importance: 0.8,
                confidence: 0.9,
              },
              {
                type: "episode",
                content: "用户可能今天很累",
                importance: 0.4,
                confidence: 0.4,
              },
            ],
          };
        },
      },
    });

    const result = await runtime.handleMessage({
      ownerId: "user-a",
      companionId: "companion",
      conversationId: "conversation-a",
      channel: "platform",
      text: "我喜欢简洁回答",
    });

    assert.equal(result.memoriesCreated.length, 1);
    assert.equal(result.memoriesCreated[0]?.content, "用户喜欢简洁回答");
    assert.deepEqual(result.memoriesCreated[0]?.sourceMessageIds, [result.messageId]);
    assert.equal(result.memoriesCreated[0]?.origin, "model_extracted");
  });

  it("uses provider embeddings and marks explicit memories as user-confirmed", async () => {
    const runtime = new CompanionRuntime({
      now: () => 2000,
      provider: {
        name: "embedding-provider",
        async generate() {
          return { text: "我记住了。" };
        },
        async embed(texts) {
          return texts.map(() => [1, 0]);
        },
      },
    });

    const result = await runtime.handleMessage({
      ownerId: "user-a",
      companionId: "companion",
      conversationId: "conversation-a",
      channel: "platform",
      text: "我现在喜欢清淡的食物",
      memoryCandidates: [
        {
          type: "preference",
          key: "preference.food",
          content: "用户现在喜欢清淡的食物",
          importance: 0.8,
          confidence: 0.95,
        },
      ],
    });

    assert.deepEqual(result.memoriesCreated[0]?.embedding, [1, 0]);
    assert.equal(result.memoriesCreated[0]?.origin, "user_explicit");
  });

  it("re-embeds legacy memories when a semantic provider becomes available", async () => {
    const memory = new MemoryStore([
      {
        id: "legacy-memory",
        ownerId: "user-a",
        companionId: "companion",
        type: "fact",
        content: "用户养了一只猫",
        importance: 0.8,
        confidence: 0.9,
        createdAt: 1,
        lastAccessedAt: 1,
        validFrom: 1,
        sourceMessageIds: ["old-message"],
      },
    ]);
    const runtime = new CompanionRuntime({
      memory,
      now: () => 2000,
      provider: {
        name: "embedding-provider",
        async generate() {
          return { text: "记得。" };
        },
        async embed(texts) {
          return texts.map((_, index) => [index + 1, index + 2]);
        },
      },
    });

    const result = await runtime.handleMessage({
      ownerId: "user-a",
      companionId: "companion",
      conversationId: "conversation-a",
      channel: "platform",
      text: "你还记得我的猫吗",
    });

    assert.deepEqual(memory.get("legacy-memory")?.embedding, [2, 3]);
    assert.deepEqual(result.memoriesUpdated.map((item) => item.id), ["legacy-memory"]);
  });
});

describe("CompanionRuntime working memory", () => {
  function recordingProvider(reply = (request: ModelRequest) => `回：${request.userText}`) {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      name: "recording",
      async generate(request) {
        requests.push(request);
        return { text: reply(request) };
      },
    };
    return { provider, requests };
  }

  const input = (text: string, conversationId = "c") => ({
    ownerId: "o",
    companionId: "default-companion",
    conversationId,
    channel: "platform" as const,
    text,
  });

  it("passes prior turns to the provider in order, excluding the current turn", async () => {
    let clock = 0;
    const { provider, requests } = recordingProvider();
    const runtime = new CompanionRuntime({ provider, now: () => (clock += 1000) });
    await runtime.handleMessage(input("我养了只猫叫年糕"));
    await runtime.handleMessage(input("它今天又把纸巾拆了"));
    await runtime.handleMessage(input("你是真人吗"));

    assert.deepEqual(requests[0]?.history, []);
    assert.deepEqual(
      requests[2]?.history.map((message) => [message.role, message.text]),
      [
        ["user", "我养了只猫叫年糕"],
        ["assistant", "回：我养了只猫叫年糕"],
        ["user", "它今天又把纸巾拆了"],
        ["assistant", "回：它今天又把纸巾拆了"],
      ],
    );
    assert.ok(requests[2]?.history.every((message) => message.text !== "你是真人吗"));
    const otherConversation = await runtime.handleMessage(input("你好", "other"));
    assert.equal(requests[3]?.history.length, 0, `history is per conversation (${otherConversation.reply})`);
  });

  it("respects the history message limit and character budget, keeping the newest", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: (index % 2 ? "assistant" : "user") as "user" | "assistant",
      text: `${index}`.repeat(10),
      createdAt: index,
    }));
    assert.deepEqual(
      selectHistory(messages, undefined, { historyLimit: 4, historyCharBudget: 1000 }).map((m) => m.createdAt),
      [6, 7, 8, 9],
    );
    assert.deepEqual(
      selectHistory(messages, undefined, { historyLimit: 20, historyCharBudget: 25 }).map((m) => m.createdAt),
      [8, 9],
    );
    assert.deepEqual(
      selectHistory(messages, 7, { historyLimit: 20, historyCharBudget: 1000 }).map((m) => m.createdAt),
      [8, 9],
    );
    const huge = selectHistory([{ role: "user", text: "长".repeat(50), createdAt: 1 }], undefined, {
      historyLimit: 5,
      historyCharBudget: 10,
    });
    assert.equal(huge[0]?.text.length, 10);
  });

  it("summarizes old messages in the background and includes the summary in later prompts", async () => {
    let clock = 0;
    const { provider, requests } = recordingProvider();
    const runtime = new CompanionRuntime({
      provider: Object.assign(provider, {
        async summarize(request: SummaryRequest) {
          return `${request.previousSummary ?? ""}摘要(${request.messages.map((m) => m.text).join("|")})`;
        },
      }),
      now: () => (clock += 1000),
      workingMemory: { historyLimit: 4, summaryThreshold: 4, summaryChunkSize: 6 },
    });
    for (let turn = 1; turn <= 5; turn += 1) {
      await runtime.handleMessage(input(`第${turn}句`));
      await runtime.waitForBackgroundTasks();
    }
    const stored = await runtime.history.getSummary?.({ ownerId: "o", companionId: "default-companion", conversationId: "c" });
    assert.equal(stored?.summary, "摘要(第1句|回：第1句|第2句|回：第2句|第3句|回：第3句)");

    await runtime.handleMessage(input("第6句"));
    const last = requests[requests.length - 1];
    assert.equal(last?.summary, stored?.summary);
    assert.match(last?.systemPrompt ?? "", /你们之前聊过的内容（摘要）\n摘要\(第1句/u);
    assert.deepEqual(last?.history.map((m) => m.text), ["第4句", "回：第4句", "第5句", "回：第5句"]);
  });

  it("never blocks the reply on summarization and ignores summary failures", async () => {
    let clock = 0;
    const warnings: string[] = [];
    let releaseSummary: () => void = () => undefined;
    const { provider } = recordingProvider();
    const runtime = new CompanionRuntime({
      provider: Object.assign(provider, {
        summarize: () =>
          new Promise<string>((_resolve, reject) => {
            releaseSummary = () => reject(new Error("summary model down"));
          }),
      }),
      now: () => (clock += 1000),
      workingMemory: { historyLimit: 2, summaryThreshold: 1, summaryChunkSize: 4 },
      logger: { warn: (message) => warnings.push(message) },
    });
    for (let turn = 1; turn <= 3; turn += 1) {
      await runtime.handleMessage(input(`第${turn}句`));
    }
    const fourth = await runtime.handleMessage(input("第4句"));
    assert.equal(fourth.reply, "回：第4句", "turns complete while the summary is still pending");
    releaseSummary();
    await runtime.waitForBackgroundTasks();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /summary failed/u);
  });

  it("serializes concurrent turns on one conversation but not across conversations", async () => {
    const events: string[] = [];
    const requests: ModelRequest[] = [];
    let clock = 0;
    const runtime = new CompanionRuntime({
      now: () => (clock += 10),
      provider: {
        name: "slow",
        async generate(request) {
          requests.push(request);
          events.push(`start:${request.userText}`);
          await new Promise((resolve) => setTimeout(resolve, request.userText === "一" ? 30 : 5));
          events.push(`end:${request.userText}`);
          return { text: `回${request.userText}` };
        },
      },
    });
    await Promise.all([
      runtime.handleMessage(input("一")),
      runtime.handleMessage(input("二")),
      runtime.handleMessage(input("别处", "elsewhere")),
    ]);
    assert.deepEqual(
      events.filter((event) => !event.includes("别处")),
      ["start:一", "end:一", "start:二", "end:二"],
    );
    assert.ok(events.indexOf("start:别处") < events.indexOf("end:一"), "other conversations are not blocked");
    const second = requests.find((request) => request.userText === "二");
    assert.deepEqual(second?.history.map((m) => m.text), ["一", "回一"]);
  });

  it("decays emotion to now before building the prompt", async () => {
    const now = Date.parse("2026-10-06T20:00:00+08:00");
    const { provider, requests } = recordingProvider();
    const runtime = new CompanionRuntime({ provider, now: () => now });
    runtime.restoreEmotion("o", "default-companion", {
      pleasure: 0.9,
      arousal: 0.1,
      dominance: 0,
      trust: 0,
      bonding: 0,
      energy: 0.7,
      updatedAt: now - 10 * 24 * 60 * 60 * 1000,
    });
    await runtime.handleMessage(input("在吗"));
    assert.ok((requests[0]?.emotion.pleasure ?? 1) < 0.35, "pleasure decayed toward the base");
    assert.equal(requests[0]?.emotion.updatedAt, now);
    assert.match(requests[0]?.systemPrompt ?? "", /心情平平常常/u);
    assert.doesNotMatch(requests[0]?.systemPrompt ?? "", /心情挺好/u);
  });

  it("builds persona, time and gap sections from the profile source, timezone and history", async () => {
    const now = Date.parse("2026-10-06T01:40:00+08:00");
    const day = 24 * 60 * 60 * 1000;
    const { provider, requests } = recordingProvider();
    const built: string[] = [];
    const runtime = new CompanionRuntime({
      provider,
      now: () => now,
      profiles: { get: (id) => (id === "default-companion" ? { ...XIAO_MAN_PROFILE, name: "阿满" } : undefined) },
      history: {
        recentMessages: () => [
          { role: "user", text: "晚安", createdAt: now - 3 * day },
          { role: "assistant", text: "晚安呀", createdAt: now - 3 * day + 1000 },
        ],
      },
      onPromptBuilt: (info) => built.push(info.sections.map((section) => section.id).join(",")),
    });
    const result = await runtime.handleMessage({ ...input("睡不着"), personality: "今天有点困。" });
    const prompt = requests[0]?.systemPrompt ?? "";
    assert.match(prompt, /你叫阿满/u);
    assert.match(prompt, /凌晨 01:40（Asia\/Shanghai）/u);
    assert.match(prompt, /距离上次聊天已经过了 3 天/u);
    assert.match(prompt, /额外设定（和上面的角色设定冲突时以这里为准）\n今天有点困。/u);
    assert.match(prompt, /绝对不要说这些话：.*“作为AI”/u);
    assert.equal(built[0], "preamble,identity,override,style,mood,time,memories,safety");
    assert.ok(result.repliedAt > result.userMessageAt);

    await runtime.handleMessage({ ...input("hi"), timezone: "America/New_York" });
    assert.match(requests[1]?.systemPrompt ?? "", /2026年10月5日 星期一 下午 13:40（America\/New_York）/u);
  });
});

describe("CompanionRuntime reply rhythm and style checks", () => {
  const scope = { ownerId: "o", companionId: "default-companion", conversationId: "c" };
  const base = { ...scope, channel: "platform" as const };

  it("splits replies into paced bubbles with staggered timestamps and stores them in order", async () => {
    let clock = 10_000;
    const runtime = new CompanionRuntime({
      now: () => clock,
      random: () => 0.5,
      provider: {
        name: "slow",
        async generate() {
          clock += 300; // model latency
          return { text: "笑死\n\n它是不是专挑你在家的时候拆" };
        },
      },
    });
    const result = await runtime.handleMessage({ ...base, text: "它今天又把纸巾拆了", receivedAt: 10_000 });
    assert.deepEqual(result.messages.map((m) => [m.id.replace(result.messageId, "#"), m.text, m.delayMs]), [
      ["#:assistant", "笑死", 220],
      ["#:assistant:1", "它是不是专挑你在家的时候拆", 1180],
    ]);
    assert.deepEqual(result.messages.map((m) => m.createdAt), [10_520, 11_700]);
    assert.equal(result.reply, "笑死\n它是不是专挑你在家的时候拆");
    const stored = runtime.history.recentMessages(scope, 10) as Array<{ role: string; text: string; createdAt: number }>;
    assert.deepEqual(stored.map((m) => [m.role, m.text, m.createdAt]), [
      ["user", "它今天又把纸巾拆了", 10_000],
      ["assistant", "笑死", 10_520],
      ["assistant", "它是不是专挑你在家的时候拆", 11_700],
    ]);

    const instant = await runtime.handleMessage({ ...base, text: "哈哈", replyRhythm: "instant" });
    assert.deepEqual(instant.messages.map((m) => m.delayMs), [0, 0]);
    assert.ok((instant.messages[1]?.createdAt ?? 0) > (instant.messages[0]?.createdAt ?? 0));
  });

  it("accepts a burst of user messages, stores them separately and passes them as separate turns", async () => {
    const requests: ModelRequest[] = [];
    let clock = 5000;
    const runtime = new CompanionRuntime({
      now: () => (clock += 10),
      provider: {
        name: "recording",
        async generate(request) {
          requests.push(request);
          return { text: "收到" };
        },
      },
    });
    const result = await runtime.handleMessage({ ...base, text: ["在吗", "问你个事", " "], receivedAt: 5000 });
    assert.deepEqual(requests[0]?.userTexts, ["在吗", "问你个事"]);
    assert.equal(requests[0]?.userText, "在吗\n问你个事");
    assert.match(requests[0]?.systemPrompt ?? "", /对方刚才连着发了 2 条消息/u);
    assert.deepEqual(result.userMessages.map((m) => [m.id.endsWith(":user") || m.id.endsWith(":user:1"), m.text, m.createdAt]), [
      [true, "在吗", 4999],
      [true, "问你个事", 5000],
    ]);
    await runtime.handleMessage({ ...base, text: "然后呢" });
    assert.deepEqual(requests[1]?.history.map((m) => [m.role, m.text]), [
      ["user", "在吗"],
      ["user", "问你个事"],
      ["assistant", "收到"],
    ]);
  });

  it("adds a no-question instruction after question-heavy turns and flags copied example lines", async () => {
    const replies = ["你吃了吗", "好家伙", "那你呢？", "不过陪你聊天这件事是真的，这个不掺水"];
    const requests: ModelRequest[] = [];
    const flags: string[] = [];
    const runtime = new CompanionRuntime({
      provider: {
        name: "scripted",
        async generate(request) {
          requests.push(request);
          return { text: replies[requests.length - 1] ?? "嗯" };
        },
      },
      profiles: { get: () => XIAO_MAN_PROFILE },
      onStyleFlag: (flag) => flags.push(`${flag.kind}:${flag.detail}`),
    });
    const results = [];
    for (const text of ["一", "二", "三", "四"]) {
      results.push(await runtime.handleMessage({ ...base, text, replyRhythm: "instant" }));
    }
    const avoid = /这轮不要用问句结尾/u;
    assert.doesNotMatch(requests[0]?.systemPrompt ?? "", avoid);
    assert.match(requests[1]?.systemPrompt ?? "", avoid, "the previous reply ended with a question");
    assert.doesNotMatch(requests[2]?.systemPrompt ?? "", avoid, "1 of the last 2 turns, and not the last one");
    assert.match(requests[3]?.systemPrompt ?? "", avoid, "2 of the last 3 turns");
    assert.deepEqual(results.map((r) => r.debug.endedWithQuestion), [true, false, true, false]);
    assert.equal(results[3]?.debug.copiedExample, "不过陪你聊天这件事是真的这个不掺水");
    assert.deepEqual(flags, ["copied-example:不过陪你聊天这件事是真的这个不掺水"]);
    assert.equal(results[0]?.debug.copiedExample, undefined);
  });
});
