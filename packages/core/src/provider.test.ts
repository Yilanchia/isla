import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DemoProvider, OpenAICompatibleProvider, parseCompanionModelContent } from "./provider.js";

describe("OpenAICompatibleProvider", () => {
  it("extracts structured emotion metadata without exposing the protocol marker", () => {
    const result = parseCompanionModelContent(
      '我记住了。[[COMPANION_EMOTION]]{"delta":{"trust":0.2,"bonding":0.1},"importance":0.7,"reason":"用户分享了偏好"}',
    );

    assert.equal(result.text, "我记住了。");
    assert.deepEqual(result.emotionEvent, {
      delta: { trust: 0.2, bonding: 0.1 },
      importance: 0.7,
      reason: "用户分享了偏好",
    });
  });

  it("extracts memory candidates from the combined state protocol", () => {
    const result = parseCompanionModelContent(
      '我会记住。[[COMPANION_STATE]]{"emotionEvent":{"delta":{"trust":0.2},"importance":0.7,"reason":"用户明确表达了信任"},"memoryCandidates":[{"type":"preference","content":"用户喜欢简洁的回答","importance":0.8,"confidence":0.9,"key":"preference.style"}]}',
    );

    assert.equal(result.text, "我会记住。");
    assert.deepEqual(result.memoryCandidates, [
      {
        type: "preference",
        content: "用户喜欢简洁的回答",
        importance: 0.8,
        confidence: 0.9,
        key: "preference.style",
      },
    ]);
    assert.equal(result.emotionEvent?.delta.trust, 0.2);
  });

  it("keeps ordinary model output compatible", () => {
    assert.deepEqual(parseCompanionModelContent("普通回复"), { text: "普通回复" });
    assert.deepEqual(parseCompanionModelContent("回复[[COMPANION_EMOTION]]不是 JSON"), {
      text: "回复",
    });
  });

  it("adds the emotion protocol to compatible model requests", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "收到。" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: "https://example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      const result = await provider.generate({
        userText: "你好",
        systemPrompt: "你是一个稳定的陪伴角色。",
        memories: [],
        emotion: {
          pleasure: 0.1,
          arousal: 0,
          dominance: 0,
          trust: 0,
          bonding: 0,
          energy: 0.7,
          updatedAt: 1,
        },
        history: [],
      });

      assert.equal(result.text, "收到。");
      assert.match(requestBody, /\[\[COMPANION_STATE\]\]/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requests semantic embeddings and restores the provider order", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: "https://example.com/v1",
        apiKey: "test-key",
        model: "chat-model",
        embeddingModel: "embedding-model",
      });
      assert.deepEqual(await provider.embed?.(["第一条", "第二条"]), [[1, 0], [0, 1]]);
      assert.equal(requestUrl, "https://example.com/v1/embeddings");
      assert.deepEqual(JSON.parse(requestBody), { model: "embedding-model", input: ["第一条", "第二条"] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends prior turns between the system prompt and the current message, in order", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<{ messages: Array<{ role: string; content: string }>; temperature: number }> = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ choices: [{ message: { content: "好呀" } }] }), { status: 200 });
    };
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: "https://example.com/v1/", apiKey: "k", model: "m" });
      await provider.generate({
        userText: "它今天又把纸巾拆了",
        systemPrompt: "系统",
        memories: [],
        emotion: { pleasure: 0, arousal: 0, dominance: 0, trust: 0, bonding: 0, energy: 0, updatedAt: 0 },
        history: [
          { role: "assistant", text: "早呀", createdAt: 1 },
          { role: "user", text: "我养了只猫叫年糕", createdAt: 2 },
          { role: "assistant", text: "年糕这名字好可爱", createdAt: 3 },
          { role: "assistant", text: "是什么颜色的", createdAt: 4 },
        ],
      });
      assert.deepEqual(
        bodies[0]?.messages.map((message) => [message.role, message.role === "system" ? "" : message.content]),
        [
          ["system", ""],
          ["assistant", "早呀"],
          ["user", "我养了只猫叫年糕"],
          ["assistant", "年糕这名字好可爱\n\n是什么颜色的"],
          ["user", "它今天又把纸巾拆了"],
        ],
      );

      const summary = await provider.summarize({
        companionName: "Companion",
        messages: [{ role: "user", text: "我养了只猫叫年糕", createdAt: 1 }],
      });
      assert.equal(summary, "好呀");
      assert.equal(bodies[1]?.messages.length, 2);
      assert.doesNotMatch(bodies[1]?.messages[0]?.content ?? "", /COMPANION_STATE/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("gives a deterministic demo summary merged with the previous one", async () => {
    const demo = new DemoProvider();
    const summary = await demo.summarize({
      companionName: "Companion",
      previousSummary: "之前：用户在准备考试。",
      messages: [
        { role: "user", text: "我养了只猫叫年糕", createdAt: 1 },
        { role: "assistant", text: "好可爱", createdAt: 2 },
      ],
    });
    assert.equal(summary, "之前：用户在准备考试。\n2 条消息里用户说过：我养了只猫叫年糕");
  });

  it("sends burst messages as consecutive user turns and retries merged if the endpoint rejects that", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
      bodies.push(body);
      const consecutive = body.messages.some((message, index) => index > 0 && body.messages[index - 1]?.role === message.role);
      return consecutive
        ? new Response("{}", { status: 400 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "好" } }] }), { status: 200 });
    };
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: "https://example.com/v1", apiKey: "k", model: "m" });
      const result = await provider.generate({
        userText: "在吗\n问你个事",
        userTexts: ["在吗", "问你个事"],
        systemPrompt: "系统",
        memories: [],
        emotion: { pleasure: 0, arousal: 0, dominance: 0, trust: 0, bonding: 0, energy: 0, updatedAt: 0 },
        history: [],
      });
      assert.equal(result.text, "好");
      assert.deepEqual(bodies[0]?.messages.slice(1).map((m) => [m.role, m.content]), [
        ["user", "在吗"],
        ["user", "问你个事"],
      ]);
      assert.deepEqual(bodies[1]?.messages.slice(1).map((m) => [m.role, m.content]), [["user", "在吗\n问你个事"]]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lets the demo provider speak as the companion in two bubbles", async () => {
    const result = await new DemoProvider().generate({
      userText: "你好",
      companionName: "林笙",
      systemPrompt: "",
      memories: [],
      emotion: { pleasure: 0, arousal: 0, dominance: 0, trust: 0, bonding: 0, energy: 0, updatedAt: 0 },
      history: [],
    });
    assert.match(result.text, /林笙在呢/u);
    assert.equal(result.text.split("\n\n").length, 2);
  });
});
