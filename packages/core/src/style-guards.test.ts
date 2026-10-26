import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { endsWithQuestion, findCopiedExample, questionGuard, recentAssistantTurns } from "./style-guards.js";
import type { HistoryMessage } from "./types.js";

const user = (text: string): HistoryMessage => ({ role: "user", text, createdAt: 0 });
const bot = (text: string): HistoryMessage => ({ role: "assistant", text, createdAt: 0 });

describe("question-ending guard", () => {
  it("detects question endings, ignoring trailing emoji and tildes", () => {
    assert.ok(endsWithQuestion("你吃了吗"));
    assert.ok(endsWithQuestion("它现在趴哪儿呢～"));
    assert.ok(endsWithQuestion("真的？😂"));
    assert.ok(endsWithQuestion("why?"));
    assert.ok(!endsWithQuestion("好家伙，拆家选手"));
    assert.ok(!endsWithQuestion("我也想吃～😋"));
  });

  it("detects questions written without a question mark, from the last clause only", () => {
    for (const text of ["咋啦", "一般也分好几种。你今天是哪种", "后来圆回来没，还是就那么僵着了", "你呢，无辣不欢还是跟我一样怂", "吃了没", "后来呢哈哈哈", "你是不是又熬夜了～"]) {
      assert.ok(endsWithQuestion(text), text);
    }
    for (const text of [
      "香菜我直接一整盘下清汤那边，谁劝都不好使哈哈",
      "火锅必点啥啊，我私心觉得香菜该有一席之地",
      "我还没",
      "我还是觉得早点睡好",
      "不过你别学我，饭还是要按点吃。",
      "我也不知道为什么",
      "不管哪种，先吃点东西再说别的。",
      "要不要接着聊甩锅那事，或者先吃饭，你挑。",
      "什么都行",
    ]) {
      assert.ok(!endsWithQuestion(text), text);
    }
  });

  it("groups bubbles into turns and asks to avoid a question after 2 of 3 or after the last one", () => {
    const history = [user("a"), bot("哈哈"), bot("你呢？"), user("b"), bot("懂了"), user("c"), bot("然后呢")];
    assert.deepEqual(recentAssistantTurns(history, 3), ["哈哈\n你呢？", "懂了", "然后呢"]);
    assert.deepEqual(questionGuard(history), {
      questionEndings: 2,
      turnsConsidered: 3,
      lastEndedWithQuestion: true,
      avoidQuestion: true,
    });
    assert.equal(questionGuard([user("a"), bot("你呢？"), user("b"), bot("好吧"), user("c"), bot("哈哈")]).avoidQuestion, false);
    assert.equal(questionGuard([user("a"), bot("好吧"), user("b"), bot("哈哈")]).avoidQuestion, false);
    assert.equal(questionGuard([]).avoidQuestion, false);
  });
});

describe("example-copy detector", () => {
  const examples = ["不是哦，我是 AI\n不过陪你聊天这件事是真的，这个不掺水", "九点？？好家伙\n快去吃点热乎的"];

  it("flags a reply sharing a run of 6+ characters with an example, ignoring punctuation", () => {
    assert.equal(
      findCopiedExample("不是哦 我是AI～ 不过陪你聊年糕这事是真的，这个不掺水～", examples),
      "不是哦我是AI不过陪你聊",
    );
    assert.equal(findCopiedExample("跟你说 这事是真的，这个不掺水", examples), "事是真的这个不掺水");
    assert.equal(findCopiedExample("快去吃点热乎的吧", examples), "快去吃点热乎的");
  });

  it("does not flag ordinary replies or short overlaps", () => {
    assert.equal(findCopiedExample("好家伙，拆家选手", examples), undefined);
    assert.equal(findCopiedExample("对，我是 AI 啦", examples), undefined);
    assert.equal(findCopiedExample("十点？好家伙", examples), undefined);
  });
});
