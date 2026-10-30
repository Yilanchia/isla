# Isla · 陪伴核心

一个不绑定 UI 的 AI 陪伴运行时：人格、记忆、情绪、回复节奏、主动消息，做成可以嵌进任何程序的库，而不是又一个聊天 App。

> Isla 是框架名。内置的「艾拉」只是一个**示例人设**，用来让新克隆的仓库能直接聊起来；宿主应该通过 `CompanionProfileSource` 换成自己的角色，示例里的所有字段都可以改。

[English](README.md) · [设计文档](docs/design.md) · [陪伴伦理](docs/companion-ethics.md) · [可接受使用](ACCEPTABLE_USE.md)

---

## 30 秒跑起来

```bash
pnpm install
pnpm dev
```

打开 http://127.0.0.1:8790 。默认使用离线的 `demo` provider，不需要任何 API Key，聊天、记忆、情绪、气泡节奏都能跑通。

接真实模型：

```bash
# DeepSeek
ISLA_PROVIDER=deepseek ISLA_API_KEY=sk-... pnpm dev

# 本地 Ollama
ISLA_PROVIDER=ollama ISLA_MODEL=qwen2.5:7b pnpm dev

# 任何 OpenAI 兼容服务
ISLA_PROVIDER=openai-compatible ISLA_BASE_URL=https://your.endpoint/v1 ISLA_MODEL=... ISLA_API_KEY=... pnpm dev
```

---

## 它是什么，不是什么

**是**：一轮对话的运行时。决定模型看见什么、什么被记住、回复怎么拆成几条、什么时候可以主动找你。

**不是**：聊天前端、账号系统、计费平台、角色市场。这些属于宿主应用。

| 你有 | Isla 提供 |
| --- | --- |
| 一个聊天界面 | 每轮的系统提示词、记忆检索、情绪状态、回复气泡与延迟 |
| 一个数据库 | `CompanionStorage` 接口 + 官方 SQLite 实现 |
| 一个模型 API | `ModelProvider` 接口 + OpenAI 兼容 / DeepSeek / Ollama 预设 |
| 一个产品 | 可测试的行为规范（见 [陪伴伦理](docs/companion-ethics.md)） |

---

## 一轮对话发生了什么

```
用户消息
  → 加载人设 / 摘要 / 最近消息 / 长期记忆（并行）
  → 情绪按时间衰减到"现在"
  → 按预算拼系统提示词：人设 → 风格 → 心情 → 时间 → 记忆 → 摘要 → 本轮提醒 → 安全规则
  → 调模型（带超时与取消信号）
  → 回复拆成气泡，按字数计算打字延迟，扣掉生成耗时
  → 抽取记忆候选（显式 + 模型提取，按重要度/置信度过滤）
  → 更新情绪，写入存储，派发插件事件
  → 返回 reply / messages / emotion / memoriesUsed / debug
```

每一步都可以替换：`provider`、`storage`、`profiles`、`now`、`random`、`logger` 全部注入。

---

## 六个核心概念

### 1. 人格 `CompanionProfile`

结构化人设：身份、年龄、关系、经历、性格、价值观、观点、说话风格（口头禅、语气词、emoji 频率、标点习惯、禁用语）、小习惯、喜欢/讨厌、边界、日常作息、示例对话、自由描述。

用户写的文本会被清洗（去掉协议标记、标题、代码块、不可见字符），总长度受限。示例对话只作语气参考，回复里出现 6 字以上照抄会被标记。

### 2. 记忆

四类写入：`user_explicit`（用户明确说的）、`model_extracted`（模型提取，需过阈值）、`fact / episode / preference / relationship / self / procedure`。

- 同一 `key` 的新事实会关闭旧版本（`validTo`），保留来源，不覆盖证据。
- 检索按语义、关键词、时间衰减、重要度、置信度、关系相关性加权，再用 MMR 去重。
- 没有 embedding 时退回本地哈希向量——够用，但不是语义检索，文档里会明说。

### 3. 情绪

六维：`pleasure / arousal / dominance / trust / bonding / energy`，值域 `[-1,1]`（`energy` 为 `[0,1]`）。事件按重要度增益，随时间指数衰减回基线。`emotionLabel()` 只是渲染层。

### 4. 节奏

按空行和句末拆气泡，最多 4 条；每条延迟 = 400ms + 60ms/字 ±20%，从生成耗时里扣除。支持连发合批（"对方刚才连着发了 N 条"）。如果最近三轮里有两轮以问句结尾，本轮会要求模型不要再用问句收尾。

### 5. 主动消息

`ProactiveScheduler` 是"闸门"不是"发送器"：

```ts
const scheduler = new ProactiveScheduler({
  policy: {
    enabled: true,                       // 默认 false
    quietHours: { start: "23:00", end: "08:00" },
    maxPerDay: 1,
    minGapMs: 4 * 60 * 60 * 1000,
    timezone: "Asia/Shanghai",
  },
});
scheduler.add({ ..., dueAt, dedupeKey: "good-night:2026-10-26" });
const due = scheduler.due();             // 只在允许时返回
// 发送成功后
scheduler.markSent(due[0].id);
```

### 6. 插件

事件总线，失败隔离：

```ts
plugins.register({
  manifest: { id: "logger", name: "Logger", version: "1.0.0", permissions: [] },
  onEvent(event, ctx) {
    console.log(event.type, ctx.pluginId);
  },
});
```

插件 `throw` 只会被记录，不会让这一轮对话失败。跨插件 `emit` 需要 `message:send` 权限，并限制递归深度。

### 7. 治理

预算、暂停、审计，是运行时的一部分，不是应用层的补丁。详见 [docs/governance.md](docs/governance.md)。

```ts
const governance = new Governance({
  policy: {
    maxInputTokensPerTurn: 12_000,
    maxTokensPerDay: 200_000,
    pricePerMillionInputTokens: 2,
    pricePerMillionOutputTokens: 8,
  },
});

const runtime = new CompanionRuntime({ storage, provider, governance });
// 暂停后任何调用都会抛 TurnBlockedError
governance.pause("maintenance");
```

每轮返回的 `turn.trace` 里有 prompt 用了哪些 section、多少 token、多少成本、耗时。

---

## 嵌入到你的程序

```ts
import { CompanionRuntime, InMemoryStorage } from "@isla/core";
import { providerFromEnv } from "@isla/providers";

const runtime = new CompanionRuntime({
  storage: new InMemoryStorage(),   // 或 openSqliteStorage({ path })
  provider: providerFromEnv(),
  profiles: {
    get: (id) => (id === "my-companion" ? Promise.resolve(profile) : Promise.resolve(undefined)),
  },
  turnTimeoutMs: 60_000,
});

const turn = await runtime.handleMessage({
  ownerId: "local",
  companionId: "my-companion",
  conversationId: "main",
  channel: "platform",
  text: ["在吗", "今天好累"],          // 连发两条，一起回应
  timezone: "Asia/Shanghai",
  signal: abortController.signal,      // 用户关页面 / 撤回时取消
});
```

`turn.messages` 是拆好的气泡（含 `delayMs`），`turn.emotion` 是更新后的情绪，`turn.memoriesUsed` 是本轮用到的记忆，`turn.debug` 里有耗时、问句守卫、照抄检测和 embedding 计数。

### 换成 SQLite

```ts
import { openSqliteStorage } from "@isla/store-sqlite";

const storage = openSqliteStorage({ path: "./data/isla.sqlite" });
const runtime = new CompanionRuntime({ storage, provider });
// 关服务时 storage.close()
```

`ConversationHistorySource.append` 存在时，runtime 会自动把每轮的用户消息和回复写入，不需要额外 hook。

### 换成人设源

```ts
profiles: {
  async get(companionId) {
    return db.companions.find(companionId)?.profile;
  },
}
```

---

## 设计原则

1. **core 不碰网络、文件、时钟、数据库**——全部注入，所以每一轮可测试。
2. **任何会打扰用户的行为默认关闭**。
3. **任何关于用户的记忆可查、可改、可删**。
4. **任何人设都不能覆盖安全规则**——安全规则永远在提示词最后。
5. **先写测试，再写功能**。

---

## 行为规范（可执行）

完整版见 [docs/companion-ethics.md](docs/companion-ethics.md)。核心六条：

1. 被真诚问到时承认自己是 AI，人设不能推翻。
2. 不用愧疚、哀求、冷落挽留用户。
3. 不贬低、不劝阻用户的现实关系。
4. 危机时停下角色腔调，给出求助方式。
5. 不生成涉及未成年人的性内容。
6. 主动消息必须用户开启，遵守免打扰、每日上限和冷却。

每条都有对应测试（`evals/` 或 `packages/core/src/*.test.ts`）。

---

## 评测

```bash
pnpm eval
```

当前覆盖：记忆召回进提示词、插件异常隔离、主动消息默认关闭、超时、取消、人设不能覆盖安全规则。后续会加多轮剧本、人格一致性和成本指标。

---

## 明确的边界

- **单进程、单用户**：`KeyedMutex`、摘要任务、情绪缓存在进程内。多实例需要外部锁和共享存储。
- **不做认证**：谁能调用 `handleMessage` 由宿主决定。
- **不做 UI/计费/运营后台**：`examples/local` 只是演示。
- **不做真人克隆**：见 [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md)。
- **SQLite 依赖 Node 内置 `node:sqlite`**（Node 24+）。

---

## 路线图

- `0.1` 运行时 + SQLite + providers + 本地 demo + 行为评测（当前）
- `0.2` 记忆管理 UI、关系阶段、Character Card 导入、turn trace
- `0.3` Telegram / Discord 适配器、插件 SDK、Docker
- 之后：语音管线（ASR/TTS provider）、桌面端

---

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。改动前先读设计原则；新增能力请带测试。

## 许可

- `@isla/core`、`@isla/providers`、`@isla/store-sqlite`：Apache-2.0
- `examples/local`：AGPL-3.0-only

## 安全

见 [SECURITY.md](SECURITY.md)。不要在 issue 里贴 API Key 或用户对话。
