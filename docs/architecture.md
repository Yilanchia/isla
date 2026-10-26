# 架构

## 包依赖

```
examples/local ──► @isla/providers ──► @isla/core
      │                  │
      └──────────► @isla/store-sqlite ──► @isla/core

evals ──► @isla/core
      └──► @isla/providers
```

方向永远指向 core，core 不依赖任何包（除了 `zod`）。

| 包 | 职责 | 依赖 |
| --- | --- | --- |
| `@isla/core` | 运行时、人设、记忆、情绪、节奏、调度、插件、存储接口 | `zod` |
| `@isla/providers` | 模型适配器与预设 | `@isla/core` |
| `@isla/store-sqlite` | SQLite 存储 | `@isla/core`、`node:sqlite` |
| `examples/local` | 单用户 Web demo | 上面三个 |
| `evals` | 行为评测 | `@isla/core`、`@isla/providers` |

## 核心对象

```
CompanionRuntime
  ├─ provider: ModelProvider          // generate / embed / summarize
  ├─ storage: CompanionStorage
  │    ├─ memory: MemoryRepository    // 同步
  │    ├─ history: ConversationHistorySource
  │    ├─ emotion: EmotionStore       // 同步
  │    └─ proactive?: ProactiveStore
  ├─ profiles: CompanionProfileSource // get(companionId)
  ├─ plugins: PluginRegistry
  ├─ now / random / logger            // 注入，测试用
  └─ handleMessage(input): TurnResult
```

`CompanionRuntime` 不持有数据库连接、不发 HTTP、不读文件。所有副作用都经过上面这些接口。

## 扩展点

| 想换什么 | 实现哪个接口 | 参考实现 |
| --- | --- | --- |
| 模型 | `ModelProvider.generate`（可选 `embed` / `summarize`） | `@isla/providers` |
| 存储 | `CompanionStorage` | `InMemoryStorage` / `openSqliteStorage` |
| 人设来源 | `CompanionProfileSource.get` | demo 里的常量对象 |
| 渠道 | 在宿主层把消息转成 `RuntimeInput` | `examples/local` 的 HTTP handler |
| 行为 | `PluginRegistry.register` | `evals` 里的测试插件 |
| 情绪曲线 | `CompanionRuntimeOptions.emotionConfig` | `TUNED_EMOTION_CONFIG` |
| 提示词预算 | `PromptBudget` / `buildPromptSections` | `DEFAULT_PROMPT_BUDGET` |

## 数据流

```
渠道（HTTP / IM / CLI）
   │  RuntimeInput
   ▼
CompanionRuntime ──► Provider（模型）
   │                   │
   │◄──────────────────┘
   ├──► Storage（memory / history / emotion / proactive）
   ├──► Plugins（message.received / turn.completed）
   └──► TurnResult
          │
          ▼
渠道渲染（气泡 + delayMs + typing）
```

## 部署形态

1. **嵌入式**：把 `@isla/core` 放进桌面应用、CLI、游戏。用 `InMemoryStorage` 或自己的存储。
2. **本地单机**：`examples/local` 的模式——一个 Node 进程 + SQLite 文件。适合个人使用。
3. **服务端**：把 `CompanionStorage` 换成 Postgres/Redis，加认证、限流、队列。当前版本需要自己补多实例能力。

## 为什么 core 这么"薄"

因为陪伴产品的差异在**行为**，不在基础设施。把模型调用、数据库、UI 都留在 core 外面，宿主才能：

- 用任何模型（包括本地模型）。
- 把记忆放到自己的数据库。
- 在多端共享同一个运行时。
- 单独测试"这一轮模型看到了什么"。

代价是宿主需要写一点胶水。`examples/local` 就是那点胶水的参考实现（约 250 行）。
