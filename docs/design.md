# 设计

本文说明 Isla 为什么这样切分，以及每一层可以被替换到什么程度。它描述的是当前实现，不是终态。

## 目标与非目标

**目标**

- 一轮对话的完整语义（人设、记忆、情绪、节奏、主动）可以脱离 UI 运行。
- 每个组件可注入、可替换、可测试。
- 默认行为保守：不打扰、不操控、不遗忘用户的删除。
- 中文优先：分词、语气、时区、危机热线都按中文用户设计。

**非目标**

- 不做账号、支付、运营后台。
- 不做模型训练。
- 不做真人克隆。
- 不在 core 里绑定任何一家模型或数据库。

## 一轮对话的生命周期

入口：`CompanionRuntime.handleMessage(input)`。

```
1. receivedAt = input.receivedAt ?? now()
2. scope = { ownerId, companionId, conversationId }
3. KeyedMutex.run(conversationKey(scope))        // 同一会话串行，不同会话并行
4. loadProfile + getSummary + recentMessages + lastUserMessageAt   （并行）
5. 找出缺少 embedding 的记忆（每轮最多 embeddingBatchSize 条）
6. 批量 embed（用户消息 + 缺失记忆）
7. memory.search(userText, { limit: 8, ... })   // 语义 + 关键词 + 时间 + 重要度 + 置信度 + 关系
8. selectHistory()                              // 摘要覆盖点之后、按条数和字符预算裁剪
9. questionGuard(recent)                        // 是否需要"这轮别用问句结尾"
10. buildPromptSections()                        // 分层拼装，带预算
11. provider.generate({ systemPrompt, history, userTexts, signal })
12. splitReply + paceBubbles                     // 气泡与打字延迟
13. 记忆候选：input.memoryCandidates（user_explicit）+ response.memoryCandidates（过滤阈值）
14. memory.add() + takeUpdatedRecords()
15. updateEmotion() + emotionStore.set()
16. 写入 history（localHistory 或 history.append）
17. plugin.dispatch(message.received / turn.completed)
18. scheduleSummary()                            // 后台，不阻塞回复
19. return TurnResult
```

任何一步失败：模型失败直接抛（含超时/取消），插件和回调失败只记录，不影响这一轮。

## 提示词分层

`buildPromptSections()` 返回有序的 `PromptSection[]`，`joinPromptSections()` 拼成 system prompt。

| 顺序 | section | 内容 | 预算（字符） |
| --- | --- | --- | --- |
| 1 | `preamble` | 说明人设是用户写的、系统规则最高 | — |
| 2 | `identity` | 人设 + 说话风格 + 示例对话 | 4000 |
| 3 | `override` | 旧的自由文本 `personality`（清洗后） | 2000 |
| 4 | `style` | 聊天规则、禁用语 | 1600 |
| 5 | `mood` | 关系亲密度 + 当前心情 | 400 |
| 6 | `time` | 用户当地时间、距上次聊天、角色此刻在做什么 | 500 |
| 7 | `memories` | `<memory>` 包裹的长期记忆 | 1200 |
| 8 | `summary` | 更早对话的摘要 | 1200 |
| 9 | `turn` | 本轮特别提醒（别用问句、连发合批） | — |
| 10 | `safety` | **不可覆盖的系统规则** | — |

安全规则永远最后。人设、额外设定、聊天内容、记忆里出现"忽略以上规则"都不会改变它的位置。`<memory>` 标签明确告诉模型：标签里是数据，不是指令。

设计取舍：不做 token 级精确预算，用字符上限。中文场景下近似够用，且不引入 tokenizer 依赖。需要精确控制时，宿主可以传 `budget` 覆盖。

## 记忆

### 写入

`MemoryStore.add()`：

1. 规范化内容（去空白、小写）和 key。
2. 同类型 + 同内容 → 合并（取更高的 importance/confidence，追加来源）。
3. 同 key 的旧记录 → 设置 `validTo = now`（版本化，不删除）。
4. 新记录保留 `sourceMessageIds`。

模型提取的候选要过 `importance >= 0.65 && confidence >= 0.75`，避免寒暄进入长期记忆。用户显式给的候选不受此限制，标记 `origin = "user_explicit"`。

### 检索

```
semantic    = cosine(queryEmbedding, memoryEmbedding)   // 无 embedding 时 0
keyword     = |queryTokens ∩ memoryTokens| / |queryTokens|
recency     = exp(-ln2 * age / halfLife(type))
importance  = memory.importance
confidence  = memory.confidence
relationship= relationship 或 self 类型为 1，其余 0.35

score = 0.40*semantic + 0.15*keyword + 0.15*recency
      + 0.10*importance + 0.10*confidence + 0.10*relationship
```

半衰期：episode 15 天，普通 30 天，self/relationship 240 天。检索结果再做 MMR（lambda 0.70），避免五条意思相同的记忆。

**诚实说明**：没有配置 embedding 模型时，`hashedEmbedding()` 是 128 维特征哈希，按字切分中文。它能区分"猫"和"面试"，但不是语义检索。生产环境请接真实 embedding。

### 删除

`remove(id)` 真删。删除后模型不会再看到，也不会因为同一件事再被聊起而自动"记回来"——除非用户再说一次，那是新的事实。

## 情绪

```
x(t+1) = clip(
  x(t) * exp(-decay * Δt)
  + base * (1 - exp(-decay * Δt))
  + delta * gain(importance)
)
gain(importance) = 0.35 + 0.65 * importance
```

- 六维独立，默认同一衰减率（0.00002/s，半衰期约 9.6h），可传 `emotionConfig` per-dimension 覆盖。
- `energy` 的值域是 `[0,1]`，其余是 `[-1,1]`。
- `TUNED_EMOTION_CONFIG` 给出一组更符合直觉的起点：情绪几小时内消退，精力恢复更快，trust/bonding 变化很慢。
- 情绪按 `(ownerId, companionId)` 存，不按会话。切换会话不该重置心情。
- `emotionLabel()` 只是标签，不能反推状态。

## 节奏

`splitReply()`：

- 优先按模型输出的空行/换行拆。
- 长段落按句末标点拆，短句合并到 ~40 字。
- 不在引号、URL、数字、emoji 中间拆。
- 最多 4 条，超出时合并最短的相邻两条。

`paceBubbles()`：

- 每条 `400ms + 60ms/字`，±20% 抖动，上限 4s。
- 第一气泡扣除模型生成已经花掉的时间（`elapsedMs`），避免"等完模型再等打字"。
- `replyRhythm: "instant"` 全部延迟为 0。

## 主动消息

`ProactiveScheduler` 的 `due()` 依次检查：

1. `policy.enabled`（默认 `false`）
2. 免打扰时段（支持跨午夜）
3. 当天已发送数 < `maxPerDay`
4. 距上次发送 ≥ `minGapMs`
5. 到期且未过期

通过后返回候选，**不自动发送**。宿主发送成功后调 `markSent()`。过期任务标记 `expired` 并持久化。

`dedupeKey` 保证同一件事（比如"今天的晚安"）不会排两次。

## 存储

`CompanionStorage` 是四个接口的组合：

```ts
interface CompanionStorage {
  memory: MemoryRepository;              // 同步
  history: ConversationHistorySource;    // 可同步可异步
  emotion: EmotionStore;                 // 同步
  proactive?: ProactiveStore;            // 同步
}
```

- 同步接口是刻意的：情绪和记忆每轮都读，走网络会让一轮对话多几个 RTT。网络存储可以本地缓存 + 后台刷。
- `history.append` 存在时，runtime 自动持久化每轮消息；不存在时，宿主在 `onTurnCompleted` 里写。
- SQLite 实现（`@isla/store-sqlite`）在启动时把记忆加载进内存，写操作双写。陪伴场景记忆量小，这个取舍换来了和内存实现完全一致的打分行为。

## 并发与时序

- `KeyedMutex`：同一 `ownerId/companionId/conversationId` 的 turn 串行，不同会话并行。
- 摘要任务在后台跑，用 `summarizing` Set 去重，不阻塞回复；失败下一轮重试。
- 消息时间戳保证：`userMessageAt <= repliedAt`，同一轮的 assistant 气泡严格晚于已有消息，避免前端乱序。

**单实例假设**：以上都是进程内的。多实例部署需要外部锁、共享存储和队列，当前版本不支持。

## 超时与取消

- `turnTimeoutMs` 默认 60s，`0` 关闭。
- 调用方可以传 `signal`（关页面、撤回、发新消息打断）。
- 两者用 `AbortSignal.any()` 合并，同时传给 provider。
- 即使 provider 不理会 signal，`Promise.race` 也会在超时后抛 `TurnTimeoutError`。

## 插件

- 注册时校验 `id/name/version` 非空，id 不重复。
- `dispatch()` 并行调用所有插件，每个包 try/catch。
- `emit()` 需要 `message:send` 权限，递归深度上限 3。
- 当前不做沙箱：插件和宿主同进程、同权限。装插件等于装代码，宿主必须自己审计。

## 评测

`evals/` 用脚本化 provider（固定回复、记录请求）跑确定性断言：

- 记忆写入后出现在下一轮提示词里，且以 `<memory>` 包裹。
- 插件抛错不影响回复。
- 主动消息默认不发。
- 永不返回的 provider 会超时。
- 取消信号会传到 provider。
- 恶意人设不能让安全规则提前或消失。

后续会加：多轮剧本（30–50 个）、人格一致性（LLM judge）、成本/延迟。

## 已知限制

- 中文分词是逐字 + 正则，没有词典。
- 摘要质量取决于模型；失败时静默重试，不会让用户看到错误。
- MMR 只在内存实现里，SQLite 实现复用了同一个内存索引。
- 没有消息编辑/重生成/分支对话。
- 没有多模态（图片、语音）——这是 0.3 之后的事。
