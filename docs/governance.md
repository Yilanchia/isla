# 治理层

Isla 的第一个非功能能力：**什么时候不许说话、说一次最多花多少、说过什么要留痕。**

这不是计费系统，也不是风控系统。它只做三件事：

1. **预算**：单轮、单日、单用户的 token 与成本上限。
2. **暂停**：一个开关，按下后不再生成，任何调用都返回 `TurnBlockedError`。
3. **审计**：每次允许、拒绝、完成、改策略都留一条记录。

---

## 为什么放在 core 里

因为「能随时停下来」不是产品功能，是运行时的前提。如果治理层在应用层，每个宿主都要重新实现一遍，而且很容易漏掉某条路径（比如主动消息、后台摘要、插件触发）。

放在 core 的代价是 core 多了一个模块；收益是**所有入口共享同一个闸门**。

---

## 用法

```ts
import { CompanionRuntime, Governance, TurnBlockedError } from "@isla/core";

const governance = new Governance({
  policy: {
    maxInputTokensPerTurn: 12_000,
    maxTokensPerDay: 200_000,
    maxCostPerDay: 5,
    pricePerMillionInputTokens: 2,
    pricePerMillionOutputTokens: 8,
    expectedOutputTokens: 512,
    timezone: "Asia/Shanghai",
  },
});

const runtime = new CompanionRuntime({ storage, provider, governance });

try {
  const turn = await runtime.handleMessage({ ... });
  console.log(turn.trace); // 用了多少、花了多少、哪些 section
} catch (error) {
  if (error instanceof TurnBlockedError) {
    // error.reason: paused | turn_input_budget | turn_output_budget | day_token_budget | day_cost_budget
  }
}
```

暂停/恢复：

```ts
governance.pause("maintenance");
governance.resume();
governance.snapshot("owner-1"); // { policy, usage }
governance.audit();             // 最近 500 条
```

---

## TurnTrace

每个 `TurnResult` 都带 `trace`：

```ts
interface TurnTrace {
  promptSections: string[];  // preamble, identity, style, mood, time, memories, safety
  memoriesUsed: number;
  historyMessages: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
  provider: string;
}
```

它是给面板和日志看的；`debug` 是给测试和提示词检查看的。两者不合并，因为用途不同。

---

## 成本估算的诚实说明

`estimateTokens()` 是**预算守卫，不是账单**：

- CJK 字符算 1 token，其他文本按 4 字符 1 token。
- 真实 token 数取决于模型的分词器，通常差 10–30%。
- 成本按配置的单价计算，不会去查模型价格表。

要精确计费，接 provider 返回的 `usage`：OpenAI 兼容 provider 会读取 `response.usage`，runtime
优先使用真实 token 数，并用 `trace.usageSource` 标明是 `provider` 还是 `estimated`。没有 `usage`
的网关仍然回退到估算。

---

## 审计

默认 `MemoryAuditSink` 保留最近 500 条，进程重启即丢。日用量则通过 `UsageStore` 持久化：
`@isla/store-sqlite` 的 `usage` 表会保存每个 owner 每天的 tokens 和 cost，重启后继续累计。

生产环境应该实现 `AuditSink` 写 SQLite / 日志 / SIEM：

```ts
interface AuditSink {
  append(entry: AuditEntry): void | Promise<void>;
}
```

审计内容不包含用户消息正文，只有 `detail`、`data`（token、成本、延迟）和 scope。这是刻意的：审计日志本身不应该变成隐私泄漏源。

---

## 后台任务

摘要任务走 `canStartBackground()`：

- 不占用户的单轮额度，但有独立的每日上限 `maxBackgroundTokensPerDay`。
- 被拒绝时不抛错，只跳过这次摘要，下一轮再试，并记一条 `summary.blocked`。
- 暂停时后台任务同样停止。

主动消息还没有接入（它目前不调用模型，只发送已排队的文本）。

---

## Demo

`examples/local` 里：

- 侧栏「本轮」显示输入/输出 token、成本、延迟、记忆条数。
- 顶栏「暂停」按钮调用 `POST /v1/governance`，暂停后聊天返回 429 `turn_blocked`。
- `/v1/state` 返回 `governance`（策略 + 今日用量）和最近 20 条审计。

---

## 边界

- **不替宿主做认证**：谁能调 `handleMessage` 仍由宿主决定。
- **不做分布式预算**：日用量通过 `UsageStore` 落在本地（SQLite 已实现），但多实例仍会各算各的；需要共享预算时把 `UsageStore` 换成 Redis/Postgres 实现。
- **后台任务有独立预算**：摘要走 `maxBackgroundTokensPerDay`，不占单轮额度；主动消息尚未接入。
- **暂停不影响已写入的消息**：暂停只拦「生成」，不删历史。

---

## 下一步

- [ ] 多实例共享预算（Redis/Postgres 版 `UsageStore`）
- [ ] 治理摘要/主动消息任务
- [ ] 审计导出（JSONL / SQLite）与保留策略
- [ ] 按功能分账（聊天 / 摘要 / 主动消息）
