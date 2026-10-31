# Changelog

## 0.4.0 — unreleased

The life kernel. Isla stops describing a character in a prompt and starts giving one a life.

- `@isla/life` (new): `Life` with a heartbeat that runs between conversations; an append-only
  `LifeEvent` log whose fold is the state (`replay()` rebuilds it exactly); drives (curiosity,
  expression, connection), energy and sleep; feelings computed by the kernel; tastes that become
  beliefs about herself; a nightly diary; `explain()` / `narrate()` to trace any event back.
- `@isla/life`: a replaceable `Mind`. `InnerMind` needs no model and can only arrange facts;
  `ModelMind` wraps any text model. Every reply records the fact ids it rests on and the ids a
  mind made up. Paid minds have a daily budget and fall back to the inner mind.
- `@isla/life`: `Genome` instead of a persona card; a small `World` (window, weather, books);
  `FileArchive` keeps a life in one JSON Lines file; long outages become a `lapsed` event.
- `@isla/life`: fixed crisis reply on self-harm messages, awake or asleep, whatever the mind.
- `@isla/core`: `OpenAICompatibleProvider.complete({ system, user })`.
- `examples/life`: a life on this machine's clock, with `--fast <hours>`, `/why` and `/state`.
- `apps/qq-service` removed.
- `docs/life-kernel.md`; `POSITIONING.md` rewritten.
- Milestone "a day alone" passes (`packages/life/src/life.test.ts`).

## 0.3.0 — unreleased

Task loops.

- `@isla/core`: `TaskRunner` with `Task` / `TaskExecutor` / `Verifier` / `Artifact`; a bounded
  verify-retry loop with cancellation, `canStart` gating and `onAttempt` callbacks.
- `docs/tasks.md`: the four primitives, a worked example, and why the verifier is the trust anchor.

## 0.2.0 — unreleased

Governance, traces, and a second transport.

- `@isla/core`: `Governance` with per-turn/per-day token and cost budgets, a pause switch and an
  audit log; `TurnBlockedError`; `TurnResult.trace` with prompt sections, token estimates, cost
  and latency.
- `@isla/core`: daily usage persists through `UsageStore`; provider-reported token usage wins
  over the estimate, marked by `trace.usageSource`.
- `@isla/core`: conversation summaries pass through `Governance.canStartBackground()` with their
  own daily cap and `summary.blocked` audit entries.
- `@isla/store-sqlite`: `usage` table for governance counters.
- `@isla/providers`: optional `maxTokens`; model errors now include a short response body.
- `apps/qq-service`: authenticated multi-session HTTP adapter for the QQ transport.
- `examples/local`: a "this turn" trace panel and a pause button.
- `docs/governance.md`, `POSITIONING.md`.
- Tests: 79 total.

## 0.1.0 — unreleased

The first cut: a headless companion runtime, a SQLite adapter, model providers and a local demo.

- `@isla/core`: `CompanionRuntime` with persona, versioned memory, six-dimension emotion,
  reply rhythm, conversation summaries, non-overridable safety rules, a proactive scheduler
  with consent/quiet-hours/cooldown, and an isolated plugin event bus.
- `@isla/store-sqlite`: persistence for memories, history, summaries, emotion and proactive jobs.
- `@isla/providers`: OpenAI-compatible, DeepSeek, Ollama and LM Studio presets plus the offline demo.
- `examples/local`: a single-user web chat with a memory panel.
- `evals`: behavioural checks (memory recall, plugin isolation, timeout, cancellation, safety order).
