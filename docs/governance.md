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

要精确计费，接 provider 返回的 `usage`（OpenAI 兼容接口在 `response.usage`），把真实值写进审计。当前版本没做，是因为不同网关的 `usage` 字段不一致，先保证「不会失控」，再谈「精确」。

---

## 审计

默认 `MemoryAuditSink` 保留最近 500 条，进程重启即丢。生产环境应该实现 `AuditSink` 写 SQLite / 日志 / SIEM：

```ts
interface AuditSink {
  append(entry: AuditEntry): void | Promise<void>;
}
```

审计内容不包含用户消息正文，只有 `detail`、`data`（token、成本、延迟）和 scope。这是刻意的：审计日志本身不应该变成隐私泄漏源。

---

## Demo

`examples/local` 里：

- 侧栏「本轮」显示输入/输出 token、成本、延迟、记忆条数。
- 顶栏「暂停」按钮调用 `POST /v1/governance`，暂停后聊天返回 429 `turn_blocked`。
- `/v1/state` 返回 `governance`（策略 + 今日用量）和最近 20 条审计。

---

## 边界

- **不替宿主做认证**：谁能调 `handleMessage` 仍由宿主决定。
- **不做分布式预算**：日用量在进程内，多实例会各算各的。多实例需要把 `usage` 放到 Redis/Postgres。
- **不拦后台任务**：摘要任务目前不受治理层约束（它不直接面向用户）。这是已知缺口，0.3 会补。
- **暂停不影响已写入的消息**：暂停只拦「生成」，不删历史。

---

## 下一步

- [ ] 把 `usage` 落到 `CompanionStorage`，支持重启后累计
- [ ] 接真实 provider usage，替换估算
- [ ] 治理摘要/主动消息任务
- [ ] 审计导出（JSONL / SQLite）
