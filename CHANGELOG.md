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
- `@isla/life`: `listen()` / `speak()` for hosts whose own agent does the talking. Being called
  wakes her (`woke.by`, a grumble when tired); external replies are grounded like a mind's and do
  not use the mind budget; a night interruption does not use up the next day's diary.
- `@isla/life`: memory. `MemoryIndex` over the log: ACT-R activation with Pavlik–Anderson
  spacing, BM25 over `Intl.Segmenter` words, Chinese time words, clear / vague / faint
  recollections. `Life.recall()` (on its own, changes nothing) and `Life.remember()` (on
  purpose, recorded as `recalled`). `gatherFacts({ cue })` adds what the cue brings to mind.
  Genome `memory: { decay, records }`. The nightly diary now covers the day's conversations.
- `@isla/life`: `gatherFacts` walks the log back from the end instead of scanning all of it;
  `@isla/core`: `localTime()` reuses one formatter per zone. A simulated month: 7.8 s → 0.15 s.
- `evals`: a year-long memory eval with regression gates.
- `@isla/life`: sleep consolidation. Each night the day becomes `episode`s (上午 / 下午 / 晚上 /
  夜里), each week and month a `chapter`, written by the kernel from the events with the ids they
  cover and mention; going over them in sleep strengthens what they mention. A question about a
  week or month is answered with its chapter; the last week and month stay among the facts.
- `@isla/life`: weather tastes read as "晴天", not "weather:晴".
- `@isla/life`: `Life.perceive()`: things outside her room enter as `perceived` events. Asleep
  she notices nothing; the host's rating reaches her only a little; the same thing again within
  a day is less new; with a `detail`, repeated perceptions become a taste.
- `@isla/life`: shelves. `Life.stock()` puts an article, a commit or an episode on a shelf;
  `shelfActivity()` turns a shelf into a pastime she picks from by the tags she has come to like.
  What she read is in her log, memory and tastes; nothing is stocked twice.
- `@isla/life`: `reachOut` / `urged`: she wants to talk to someone when she misses them, came
  across something they would care about, or still owes them something; never while they are
  talking, never asleep, not again before they answer. The host says it with `speak()`.
- `@isla/life`: `heard.where`: where the host keeps the whole conversation; recollections of what
  was heard, answered or noted carry it.
- `@isla/life`: `Life.note()` / `noted`: what she keeps about someone, by topic, resting on
  something they said; pending items and `done`. Notes about the person she is talking to stay
  among her facts, pending ones first. In the eval, reworded questions find 44–50% with notes
  against 19% without.
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
