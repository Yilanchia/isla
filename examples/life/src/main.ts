import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { OpenAICompatibleProvider } from "@isla/core";
import {
  createRoom,
  FileArchive,
  HOUR,
  InnerMind,
  ISLA_GENOME,
  Life,
  ModelMind,
  whenLabel,
  type LifeEvent,
  type Mind,
} from "@isla/life";

/**
 * Lives on this machine's clock. Her whole life is one file, `data/isla.life.jsonl`: stop the
 * process and she stops; start it again and she picks up where she was (a long gap is recorded
 * as a lapse, not filled in).
 *
 *   pnpm --filter @isla/example-life start              # live, and talk to her
 *   pnpm --filter @isla/example-life start -- --fast 24 # a separate trial life: 24 hours at once
 *
 * Set ISLA_BASE_URL, ISLA_API_KEY and ISLA_MODEL to give her a model mind; without them she
 * speaks with the inner mind, which can only arrange things that really happened.
 */
const PATH =
  process.env.ISLA_LIFE_PATH ?? fileURLToPath(new URL("../data/isla.life.jsonl", import.meta.url));

function mindFromEnv(): Mind {
  const baseUrl = process.env.ISLA_BASE_URL;
  const model = process.env.ISLA_MODEL;
  if (!baseUrl || !model) return new InnerMind();
  const provider = new OpenAICompatibleProvider({
    baseUrl,
    model,
    apiKey: process.env.ISLA_API_KEY ?? "local",
    timeoutMs: 60_000,
  });
  return new ModelMind(provider);
}

function line(event: LifeEvent, now: number): string | undefined {
  const when = whenLabel(event.at, now, ISLA_GENOME.timezone);
  switch (event.kind) {
    case "woke":
      return `${when}  醒了（${event.payload.reason}）`;
    case "slept":
      return `${when}  睡了（${event.payload.reason}）`;
    case "activity.started":
      return `${when}  ${event.payload.label}`;
    case "felt":
      return `${when}    ${event.payload.reason}`;
    case "belief":
      return `${when}  ✦ ${event.payload.statement}`;
    case "wrote":
      return `${when}  ✎ ${event.payload.text}`;
    case "reflected":
      return `${when}  日记：${event.payload.diary}`;
    case "said":
      return `${when}  ${ISLA_GENOME.name}：${event.payload.text}`;
    case "lapsed":
      return `${when}  （这段时间她没有醒着）`;
    case "limited":
      return `${when}  [${event.payload.reason}]`;
    default:
      return undefined;
  }
}

async function main(): Promise<void> {
  const fastIndex = process.argv.indexOf("--fast");
  const fastHours = fastIndex === -1 ? 0 : Number(process.argv[fastIndex + 1] ?? 24);
  // A fast-forwarded life runs ahead of the real clock, so it gets its own file: mixing it into
  // the real one would leave her stamped in the future until real time caught up.
  const path = fastHours > 0 ? PATH.replace(/\.jsonl$/u, `.fast-${Date.now()}.jsonl`) : PATH;
  let offset = 0;
  const clock = () => Date.now() + offset;
  const life = await Life.open({
    genome: ISLA_GENOME,
    world: createRoom({ seed: "isla-room" }),
    archive: new FileArchive(path),
    mind: mindFromEnv(),
    clock,
  });
  life.subscribe((event) => {
    const text = line(event, clock());
    if (text) console.log(text);
  });
  console.log(`${ISLA_GENOME.name} · ${life.events().length} 件事 · mind: ${life.mindName} · ${path}`);
  if (fastHours > 0) {
    // Fast-forward: she lives the hours for real (every decision is made), just not in real time.
    offset = fastHours * HOUR;
    await life.advanceTo(clock());
  }
  life.start();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("对她说点什么（/why <事件id> 看原因，/state 看状态，/quit 退出）");
  for await (const text of rl) {
    const input = text.trim();
    if (!input) continue;
    if (input === "/quit") break;
    if (input === "/state") {
      const state = life.state;
      console.log(JSON.stringify({ energy: state.energy, mood: state.mood, drives: state.drives, doing: state.activity?.label, asleep: state.asleep }, null, 2));
      continue;
    }
    if (input.startsWith("/why")) {
      console.log(life.narrate(input.slice(4).trim()).join("\n"));
      continue;
    }
    const { asleep } = await life.hear({ personId: "you", name: "你", text: input });
    if (asleep) console.log("（她睡着了，醒来会回你）");
  }
  rl.close();
  await life.stop();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
