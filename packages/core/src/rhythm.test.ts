import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paceBubbles, splitReply, splitSentences, typingDelay } from "./rhythm.js";

describe("splitReply", () => {
  it("uses the model's blank lines and line breaks as bubble boundaries", () => {
    assert.deepEqual(splitReply("年糕 这名字好可爱啊\n\n我私心偏猫的\n黏人吗它"), ["年糕 这名字好可爱啊", "我私心偏猫的", "黏人吗它"]);
    assert.deepEqual(splitReply("  就一句  "), ["就一句"]);
  });

  it("splits long paragraphs at sentence ends and regroups short sentences up to ~40 chars", () => {
    const bubbles = splitReply("今天好累啊。地铁上人挤人！差点没挤上去。到公司又被拉去开会，一开就是两个小时，饭都没吃上。你呢？");
    assert.deepEqual(bubbles, ["今天好累啊。地铁上人挤人！差点没挤上去。", "到公司又被拉去开会，一开就是两个小时，饭都没吃上。你呢？"]);
    assert.ok(bubbles.every((bubble) => Array.from(bubble).length <= 40));
  });

  it("never splits inside quotes, URLs, numbers or emoji runs", () => {
    assert.deepEqual(splitSentences("他说“别走！我还没说完。”然后走了~"), ["他说“别走！我还没说完。”然后走了~"]);
    assert.deepEqual(splitSentences("看这个 https://example.com/a?b=1&c=2!好玩"), ["看这个 https://example.com/a?b=1&c=2!好玩"]);
    assert.deepEqual(splitSentences("体重 3.5 公斤。还挺沉"), ["体重 3.5 公斤。", "还挺沉"]);
    assert.deepEqual(splitSentences("笑死我了！😂😂👍🏻 然后呢"), ["笑死我了！😂😂👍🏻", "然后呢"]);
    assert.deepEqual(splitSentences("真的吗？！不会吧"), ["真的吗？！", "不会吧"]);
    assert.deepEqual(splitSentences("他的书叫《你好！世界》挺好看"), ["他的书叫《你好！世界》挺好看"]);
  });

  it("caps the number of bubbles at 4 by merging the shortest neighbours", () => {
    const bubbles = splitReply("一\n\n二二\n\n三三三三三三三三\n\n四\n\n五五五五五五五五五五\n\n六");
    assert.equal(bubbles.length, 4);
    assert.equal(bubbles.join("").replace(/\s/gu, ""), "一二二三三三三三三三三四五五五五五五五五五五六");
  });
});

describe("reply pacing", () => {
  it("computes 400ms + 60ms/char with ±20% jitter and a 4s cap", () => {
    assert.equal(typingDelay("你好呀", () => 0.5), 580);
    assert.equal(typingDelay("你好呀", () => 0), 464);
    assert.equal(typingDelay("你好呀", () => 0.999999), 696);
    assert.equal(typingDelay("长".repeat(200), () => 0.5), 4000);
    assert.equal(typingDelay("👍🏻", () => 0.5), 520, "counts code points, not UTF-16 units");
  });

  it("subtracts elapsed model latency from the first bubble only, and is all zero when instant", () => {
    const paced = paceBubbles(["你好呀", "今天怎么样"], { elapsedMs: 500, random: () => 0.5 });
    assert.deepEqual(paced, [
      { text: "你好呀", delayMs: 80 },
      { text: "今天怎么样", delayMs: 700 },
    ]);
    assert.equal(paceBubbles(["你好呀"], { elapsedMs: 5000, random: () => 0.5 })[0]?.delayMs, 0);
    assert.deepEqual(
      paceBubbles(["a", "b"], { mode: "instant" }).map((bubble) => bubble.delayMs),
      [0, 0],
    );
  });
});
