# Changelog

## 0.2.0 — unreleased

Governance, traces, and a second transport.

- `@isla/core`: `Governance` with per-turn/per-day token and cost budgets, a pause switch and an
  audit log; `TurnBlockedError`; `TurnResult.trace` with prompt sections, token estimates, cost
  and latency.
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
