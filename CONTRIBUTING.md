# 贡献

## 环境

- Node.js 22.5+（推荐 24）
- pnpm 11

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm dev        # 本地 demo
```

## 设计原则（PR 会被按这个审）

1. core 不碰网络、文件、时钟、数据库——用注入。
2. 会打扰用户的行为默认关闭。
3. 关于用户的记忆必须可查、可改、可删。
4. 任何人设不能覆盖安全规则。
5. 先写测试，再写功能。

## 加一个功能

1. 开 issue 说清楚：解决什么问题、改了哪个接口、对现有行为有没有破坏。
2. 在 `packages/core/src/` 加实现和测试。测试用 `node:test`，不引入新框架。
3. 如果改了公开类型，更新 `docs/design.md` 和 README 的相关段落。
4. 如果改了安全规则，更新 `docs/companion-ethics.md`，并在 PR 描述里说明理由。
5. `pnpm -r typecheck` + `pnpm -r test` 全绿。

## 加一个 provider

实现 `ModelProvider`：

```ts
export class MyProvider implements ModelProvider {
  readonly name = "my-provider";
  async generate(request: ModelRequest): Promise<ModelResponse> {
    // request.systemPrompt / history / userTexts / signal
    return { text: "..." };
  }
  // 可选：embed(texts, signal) / summarize(request)
}
```

必须处理 `request.signal`（用户取消 / 超时）。加一个测试，用 `mock` 的 fetch 或本地假响应。

## 加一个存储

实现 `CompanionStorage` 的四个接口。注意：

- `memory` 和 `emotion` 是同步的，因为每轮都读。
- `history.append` 如果实现，runtime 会自动写；否则宿主在 `onTurnCompleted` 里写。
- 记忆的 `add()` 要保留版本化语义（同 `key` 关闭旧记录），否则检索会看到过期事实。

## 代码风格

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。
- 不引入运行时依赖，除非无法避免（当前只有 `zod`）。
- 注释解释"为什么"，不解释"是什么"。
- 中文注释可以，公开 API 的 JSDoc 用英文。

## 提交信息

```
core: add per-dimension emotion decay
providers: support Ollama without an API key
docs: explain the memory scoring formula
```

小写开头，`area: summary`，不要句号。

## 不要做的事

- 不要在 core 里加 `fetch`、`fs`、`Date.now` 的直调（用注入）。
- 不要把某个模型的私有协议写进 core。
- 不要为了"更像人"加入施压、愧疚、制造依赖的提示词。
- 不要提交 `.env`、数据库文件、真实用户对话。
