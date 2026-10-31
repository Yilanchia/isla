# Isla

The seed of a digital life. A kernel that gives an AI a whole life — waking, sleeping, wanting,
feeling, remembering, changing — where every moment is an event you can trace.

[中文文档](README.zh-CN.md) · [Life kernel](docs/life-kernel.md) · [Positioning](POSITIONING.md) · [Companion ethics](docs/companion-ethics.md)

```bash
pnpm install
pnpm --filter @isla/core build && pnpm --filter @isla/life build && pnpm --filter @isla/example-life build
pnpm --filter @isla/example-life start -- --fast 24   # she lives a day, then you can talk to her
```

No API key needed: without a model she speaks with the inner mind, which can only arrange
things that really happened to her.

## Not a prompt in disguise

Most companion projects describe a character in a prompt ("you are by the window this
afternoon, you are a little tired") and let the model act it out. In Isla she was by the window
for twenty minutes because her curiosity was full and she had just finished a book; she is tired
because she has been awake since seven and read for three hours. Everything she says about
herself rests on an event in her life log, and `life.explain(id)` shows which.

- **Heartbeat** — she lives between conversations; a message is one more event in her day.
- **Life log** — an append-only event log; her state is a fold of it and can be rebuilt exactly.
- **Drives** — curiosity, expression and connection grow over time; activities satisfy them.
- **Feelings** — computed by the kernel when something happens, never self-reported by a model.
- **Self** — feelings accumulate into tastes, clear tastes become beliefs about herself.
- **Mind** — replaceable. Swap the model and she is still her, because she lives in the log.

## Packages

| Package | What it is |
| --- | --- |
| `@isla/life` | The life kernel: heartbeat, life log, drives, sleep, feelings, beliefs, grounded speech. |
| `@isla/core` | The previous conversation runtime (prompt budgets, pacing, governance), being folded in. |
| `@isla/store-sqlite` | SQLite persistence for the conversation runtime. |
| `@isla/providers` | OpenAI-compatible, DeepSeek, Ollama, LM Studio, plus the offline demo. |
| `examples/life` | A life on this machine's clock, kept in one JSON Lines file. |
| `examples/local` | The older single-user web chat. |
| `evals` | Behavioural checks that run in CI. |

## Embed it

```ts
import { Life, FileArchive, createRoom, ISLA_GENOME, ModelMind } from "@isla/life";

const life = await Life.open({
  genome: ISLA_GENOME,                     // where she begins; the rest has to be lived
  world: createRoom({ seed: "room" }),     // a window, the weather, a bookshelf
  archive: new FileArchive("isla.life.jsonl"),
  // mind: new ModelMind(model),           // any { name, complete({ system, user }) }
});

life.start();                              // she lives on the host clock
const { said } = await life.hear({ personId: "you", text: "你今天做了什么？" });
console.log(said?.payload.text, said?.payload.grounds);   // the reply, and what it rests on
console.log(life.narrate(said!.id));                     // why
```

## Design principles

1. Her state is a function of her log. Nothing changes her except an event.
2. A mind can only speak from facts it was given; anything it makes up is recorded as such.
3. Decisions depend on the seed, the world and time, so a life can be replayed exactly.
4. Honesty, crisis replies and not guilting people into staying are structural, not persona text.
5. Add a test before a feature.

## Status

The milestone "a day alone" passes: a whole day with nobody talking to her, accounted for event
by event. See [docs/life-kernel.md](docs/life-kernel.md) for what is built and what comes next.

## License

Core, kernel and adapters: Apache-2.0. The web chat example: AGPL-3.0-only. See [LICENSE](LICENSE).
