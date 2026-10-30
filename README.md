# Isla

A headless AI companion runtime. Persona, memory, emotion, rhythm and proactive messages —
as a library you can embed, not another chat app.

[中文文档](README.zh-CN.md) · [Design](docs/design.md) · [Companion ethics](docs/companion-ethics.md) · [Acceptable use](ACCEPTABLE_USE.md)

```bash
pnpm install
pnpm dev          # http://127.0.0.1:8790
```

No API key needed: the demo runs offline with a deterministic provider.

The framework has no product character of its own: `@isla/core` ships one sample persona
(「艾拉」) so a fresh checkout can chat immediately. Replace it with your own `CompanionProfile`.

## Why another companion project

Most open-source companion projects are a character card plus a chat front-end. Isla is the
part underneath: the runtime that decides what the model sees, what gets remembered, how the
reply is paced, and when the companion is allowed to reach out.

- **Persona** — a structured profile (identity, voice, examples, boundaries, daily routine),
  sanitized, budgeted, and always followed by non-overridable safety rules.
- **Memory** — versioned facts with sources, importance/confidence, time decay and MMR, so a
  new fact closes the old one instead of overwriting its evidence.
- **Emotion** — six dimensions (pleasure, arousal, dominance, trust, bonding, energy) with
  decay and event updates; the label is a render layer, not the state.
- **Rhythm** — replies split into bubbles with typing delays, burst input, and a guard against
  ending every turn with a question.
- **Proactivity** — a scheduler with consent, quiet hours, a daily cap and a cooldown. Off by
  default.
- **Plugins** — an event bus that isolates failures, so a bad plugin cannot break a turn.
- **Governance** — per-turn and per-day token/cost budgets, a pause switch, and an audit log.
  Every turn returns a trace of sections, tokens, cost and latency. See
  [docs/governance.md](docs/governance.md).
- **Tasks** — a bounded verify-retry loop (`TaskRunner`) for code, notes, CAD or any artifact a
  host can check automatically. See [docs/tasks.md](docs/tasks.md).

## Packages

| Package | What it is |
| --- | --- |
| `@isla/core` | The runtime. No network, filesystem, clock or database of its own. |
| `@isla/store-sqlite` | SQLite persistence via Node's built-in `node:sqlite`. |
| `@isla/providers` | OpenAI-compatible, DeepSeek, Ollama, LM Studio, plus the offline demo. |
| `apps/qq-service` | Authenticated multi-session HTTP adapter for the QQ transport. |
| `examples/local` | A single-user web chat with a memory and emotion panel. |
| `evals` | Behavioural checks that run in CI. |

## Embed it

```ts
import { CompanionRuntime, InMemoryStorage } from "@isla/core";
import { providerFromEnv } from "@isla/providers";

const runtime = new CompanionRuntime({
  storage: new InMemoryStorage(),
  provider: providerFromEnv(),
  profiles: {
    get: (id) => (id === "my-companion" ? Promise.resolve(profile) : Promise.resolve(undefined)),
  },
});

const turn = await runtime.handleMessage({
  ownerId: "local",
  companionId: "my-companion",
  conversationId: "main",
  channel: "platform",
  text: "今天好累",
  timezone: "Asia/Shanghai",
});

console.log(turn.reply, turn.messages, turn.emotionLabel);
```

Bring your own model:

```bash
ISLA_PROVIDER=deepseek ISLA_API_KEY=sk-... ISLA_MODEL=deepseek-chat pnpm dev
```

## Design principles

1. The core never touches the network, the filesystem, the clock or a database — everything
   is injected, so every turn is testable.
2. Anything that interrupts the user is off by default.
3. Anything remembered about the user can be inspected, edited and deleted.
4. No persona can override the safety rules.
5. Add a test before a feature.

## Status

`0.1.0`, deliberately small. Single process, single user per runtime, no built-in auth.
See [docs/design.md](docs/design.md) for the boundaries and the roadmap.

## License

Core and adapters: Apache-2.0. The example app: AGPL-3.0-only. See [LICENSE](LICENSE).
