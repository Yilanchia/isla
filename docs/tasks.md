# 任务闭环

陪伴运行时解决「怎么陪」，任务闭环解决「怎么做事」。

这不是一个 agent 框架。Isla 不提供规划、工具、代码执行或模型调用；它只提供**一个可验证的重试循环**，以及让宿主把「做完」定义清楚的那几个原语。

---

## 四个原语

```ts
interface Task {
  id: string;
  goal: string;
  maxAttempts?: number;   // default 3
}

interface TaskExecutor {
  execute(context: TaskContext): Promise<ArtifactInput> | ArtifactInput;
}

interface Verifier {
  name: string;
  check(artifact: Artifact, context: TaskContext): Promise<VerificationResult> | VerificationResult;
}

interface VerificationResult {
  ok: boolean;
  detail: string;
  score?: number;
}
```

`Artifact` 是执行器的产出：一段补丁、一份草稿、一个文件、一个 URL。它带 `taskId` 和 `attempt`，所以每次尝试都能追溯。

`TaskContext` 给执行器看之前所有尝试和验证结果——它可以据此避免重复同一个失败。

---

## 一个例子

```ts
import { TaskRunner } from "@isla/core";

const runner = new TaskRunner({
  executor: {
    async execute({ task, attempts, verifications }) {
      const patch = await agent.propose({ goal: task.goal, attempts, verifications });
      return { content: patch, meta: { model: "deepseek-chat" } };
    },
  },
  verifier: {
    name: "pytest",
    async check(artifact) {
      const result = await runTests(artifact.content);
      return { ok: result.exitCode === 0, detail: result.summary };
    },
  },
  onAttempt: (artifact, result) => {
    console.log(`attempt ${artifact.attempt}: ${result.ok ? "pass" : result.detail}`);
  },
});

const run = await runner.run({ id: "fix-123", goal: "Fix the failing test", maxAttempts: 3 });
if (run.status === "verified") {
  await openPullRequest(run.winner.content);
}
```

---

## 为什么 verifier 是信任锚

这个循环里唯一不能由模型决定的是「做完了没有」。所以：

- **verifier 必须可自动运行、可重复、便宜。** 测试、类型检查、仿真器、形式化检查、schema 校验——都行。
- **没有 verifier 的任务，不应该自动重试。** 人类评审就是 verifier，只是慢；那就把 `maxAttempts` 设成 1。
- **verifier 抛错视为失败**，不视为通过。

这也是为什么 Isla 不做「通用科研 agent」：在不能自动验证的领域，重试只会放大幻觉。

---

## 和治理层的关系

`TaskRunner` 不认识 `Governance`，但可以接：

```ts
const runner = new TaskRunner({
  executor,
  verifier,
  canStart: (attempt) => governance.canStartBackground(ownerId, 1000).allowed,
});
```

每次尝试前检查预算/暂停；返回 false 时 `run.status = "blocked"`，不会继续烧钱。

`onAttempt` 可以用来写审计、更新 trace、把失败原因存进「研究记忆」。

---

## 边界

- **不内置 agent**：规划、工具选择、代码生成都是宿主的事。
- **不执行任意代码**：verifier 由宿主提供，Isla 不跑 shell。
- **不自动合并/部署**：`status === "verified"` 只是「验证通过」，发布决策仍在人手里。
- **不做多 agent 协作**：当前是一个 executor + 一个 verifier；评审团、投票、分工是 0.4 之后的事。
- **不保证收敛**：`maxAttempts` 用完就是 `exhausted`，不会无限重试。

---

## 下一步

- [ ] 多 verifier（AND / OR / 加权）
- [ ] 尝试的持久化（TaskStore）
- [ ] 和 `TurnTrace` 打通的 attempt trace
- [ ] 一个「改代码 → 跑测试 → 出 PR」的参考实现
