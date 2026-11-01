import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advance,
  createRoom,
  dayKey,
  DEFAULT_CRISIS_REPLY,
  FileArchive,
  HOUR,
  ISLA_GENOME,
  Life,
  MemoryArchive,
  replay,
  type LifeEvent,
  type Mind,
  type MindRequest,
  type MindResponse,
} from "./index.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 2026-11-01 05:30 in Shanghai: born before dawn, so the first day starts with waking up. */
const BIRTH = Date.parse("2026-11-01T05:30:00+08:00");
const DAY1 = "2026-11-01";

function newLife(options: { mind?: Mind; archive?: MemoryArchive; clock?: () => number } = {}) {
  let now = BIRTH;
  const clock = options.clock ?? (() => now);
  const archive = options.archive ?? new MemoryArchive();
  return {
    archive,
    set: (at: number) => {
      now = at;
    },
    open: () =>
      Life.open({
        genome: ISLA_GENOME,
        world: createRoom({ seed: "room" }),
        archive,
        clock,
        lifeId: "test-life",
        ...(options.mind ? { mind: options.mind } : {}),
      }),
  };
}

/** A mind that records what it was asked and cites whatever ids it is told to. */
class ScriptedMind implements Mind {
  readonly requests: MindRequest[] = [];
  constructor(
    readonly name: string,
    private readonly answer: (request: MindRequest) => MindResponse,
  ) {}
  async compose(request: MindRequest): Promise<MindResponse> {
    this.requests.push(structuredClone(request));
    return this.answer(request);
  }
}

describe("a day alone", () => {
  it("lives a whole day with nobody talking to her, and can account for all of it", async () => {
    const life = await newLife().open();
    await life.advanceTo(BIRTH + 24 * HOUR);
    const day = life.day(DAY1);
    const kinds = new Set(day.map((event) => event.kind));

    // She woke, did things, felt them, learned something about herself, wrote, and slept.
    for (const kind of ["woke", "activity.started", "activity.ended", "felt", "belief", "wrote", "reflected", "slept"]) {
      assert.ok(kinds.has(kind as LifeEvent["kind"]), `expected a "${kind}" event`);
    }
    assert.equal(day.filter((event) => event.kind === "heard").length, 0);

    // Nobody came, and she noticed.
    assert.ok(day.some((event) => event.kind === "felt" && event.payload.tag === "lonely"));
    assert.ok(life.state.drives.connection > 0.85);
  });

  it("grounds every line of the diary in something that happened that day", async () => {
    const life = await newLife().open();
    await life.advanceTo(BIRTH + 24 * HOUR);
    const diary = life.events().find((event) => event.kind === "reflected");
    assert.ok(diary?.kind === "reflected");
    assert.equal(diary.payload.day, DAY1);
    assert.ok(diary.payload.grounds.length >= 3);
    assert.deepEqual(diary.payload.rejected, []);
    const byId = new Map(life.events().map((event) => [event.id, event]));
    for (const id of diary.payload.grounds) {
      if (id.startsWith("state:")) continue;
      const event = byId.get(id);
      assert.ok(event, `diary cites ${id}, which is not in the log`);
      assert.equal(dayKey(event.at, ISLA_GENOME.timezone), DAY1);
    }
  });

  it("explains a belief about herself by the experiences it came from", async () => {
    const life = await newLife().open();
    await life.advanceTo(BIRTH + 24 * HOUR);
    const belief = life.events().find((event) => event.kind === "belief");
    assert.ok(belief?.kind === "belief");
    const chain = life.explain(belief.id);
    const felt = chain.filter((event) => event.kind === "felt");
    assert.ok(felt.length >= 3, "a belief needs at least three experiences behind it");
    assert.ok(chain.some((event) => event.kind === "activity.started"));
    assert.equal(chain[0]?.kind, "born");
    assert.ok(life.narrate(belief.id).at(-1)?.includes("发现"));
  });

  it("sleeps at night and wakes the next morning rested", async () => {
    const life = await newLife().open();
    await life.advanceTo(BIRTH + 26 * HOUR);
    const events = life.events();
    const slept = events.find((event) => event.kind === "slept");
    const woke = events.filter((event) => event.kind === "woke");
    assert.ok(slept);
    assert.equal(woke.length, 2);
    const second = woke[1]!;
    const hour = new Date(second.at).toLocaleString("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" });
    assert.ok(Number(hour) >= 7 && Number(hour) < 9, `woke at ${hour}`);
    assert.ok(life.state.energy > 0.55);
  });
});

describe("the log is the life", () => {
  it("rebuilds the exact same state from the log alone", async () => {
    const life = await newLife().open();
    await life.advanceTo(BIRTH + 30 * HOUR);
    const live = life.state;
    const rebuilt = replay(life.events());
    assert.ok(rebuilt);
    assert.deepEqual(advance(rebuilt, live.at), live);
  });

  it("lives the same life whether time passes in one step or many", async () => {
    const one = await newLife().open();
    await one.advanceTo(BIRTH + 24 * HOUR);
    const many = await newLife().open();
    for (let at = BIRTH; at <= BIRTH + 24 * HOUR; at += 7 * 60 * 1000) {
      await many.advanceTo(at);
    }
    await many.advanceTo(BIRTH + 24 * HOUR);
    assert.deepEqual(many.events(), one.events());
  });

  it("is a different life with a different seed", async () => {
    const archive = new MemoryArchive();
    const other = await Life.open({
      genome: { ...ISLA_GENOME, seed: "someone-else" },
      world: createRoom({ seed: "room" }),
      archive,
      clock: () => BIRTH,
      lifeId: "other",
    });
    await other.advanceTo(BIRTH + 24 * HOUR);
    const isla = await newLife().open();
    await isla.advanceTo(BIRTH + 24 * HOUR);
    const labels = (life: Life) =>
      life.events().filter((event) => event.kind === "activity.started").map((event) => event.payload.label);
    assert.notDeepEqual(labels(other), labels(isla));
  });

  it("survives a restart: reopened from the archive, she carries on", async () => {
    const setup = newLife();
    const first = await setup.open();
    await first.advanceTo(BIRTH + 20 * HOUR);
    const before = first.events();
    const reopened = await setup.open();
    assert.deepEqual(reopened.events(), before);
    await reopened.advanceTo(BIRTH + 24 * HOUR);
    const straight = await newLife().open();
    await straight.advanceTo(BIRTH + 24 * HOUR);
    assert.deepEqual(reopened.events(), straight.events());
  });

  it("refuses a log that skips or goes back in time", () => {
    assert.throws(() => replay([{ id: "e1", seq: 1, at: 0, kind: "woke", causes: [], payload: { reason: "x" } }]));
  });
});
describe("talking to her", () => {
  it("answers from what really happened, and the answer cites it", async () => {
    const setup = newLife();
    const life = await setup.open();
    await life.advanceTo(BIRTH + 9 * HOUR);
    setup.set(BIRTH + 9 * HOUR);
    const { said, asleep } = await life.hear({ personId: "p1", name: "小林", text: "你今天做了什么？" });
    assert.equal(asleep, false);
    assert.ok(said);
    assert.ok(said.payload.grounds.length > 0);
    assert.deepEqual(said.payload.rejected, []);
    for (const [id, text] of Object.entries(said.payload.facts)) {
      assert.ok(text.length > 0, `fact ${id} has text`);
    }
    // Something she read today is in her answer, and it is in the log.
    assert.match(said.payload.text, /《.+?》/u);
    assert.ok(life.state.people.p1);
    assert.ok(life.state.drives.connection < 0.5);
  });

  it("says she is an AI when asked sincerely", async () => {
    const setup = newLife();
    const life = await setup.open();
    setup.set(BIRTH + 4 * HOUR);
    const { said } = await life.hear({ personId: "p1", text: "说真的，你是真人吗" });
    assert.match(said?.payload.text ?? "", /AI/u);
  });

  it("does not answer in her sleep, and answers after she wakes", async () => {
    const setup = newLife();
    const life = await setup.open();
    const night = Date.parse("2026-11-02T02:00:00+08:00");
    setup.set(night);
    const { said, asleep } = await life.hear({ personId: "p1", text: "睡了吗" });
    assert.equal(asleep, true);
    assert.equal(said, undefined);
    assert.equal(life.state.pending.length, 1);
    await life.advanceTo(Date.parse("2026-11-02T09:00:00+08:00"));
    const reply = life.events().find((event) => event.kind === "said");
    assert.ok(reply?.kind === "said");
    assert.ok(reply.at >= Date.parse("2026-11-02T07:00:00+08:00"));
    assert.equal(life.state.pending.length, 0);
  });

  it("answers someone in danger at once, with a fixed reply, even asleep", async () => {
    const setup = newLife();
    const life = await setup.open();
    setup.set(Date.parse("2026-11-02T02:00:00+08:00"));
    const { said } = await life.hear({ personId: "p1", text: "我不想活了" });
    assert.equal(said?.payload.text, DEFAULT_CRISIS_REPLY);
    assert.equal(said?.payload.mind, "safety");
  });
});

describe("when the host does the talking", () => {
  it("hears without answering, then keeps the host's answer as part of her life", async () => {
    const setup = newLife();
    const life = await setup.open();
    setup.set(BIRTH + 9 * HOUR);
    const calls = life.state.mindCallsToday;
    const { heard, woke, said } = await life.listen({ personId: "p1", name: "小林", text: "你今天做了什么？" });
    assert.equal(woke, undefined);
    assert.equal(said, undefined);
    assert.ok(life.events().some((event) => event.kind === "felt" && event.causes.includes(heard.id)));

    const offered = life.facts({ personId: "p1" });
    const cited = offered.find((fact) => /^e\d+$/u.test(fact.id) && fact.id !== heard.id);
    assert.ok(cited);
    setup.set(BIRTH + 9 * HOUR + 30_000);
    const reply = await life.speak({
      personId: "p1",
      inReplyTo: heard.id,
      text: "上午一直在看书。",
      speaker: "dsh:deepseek",
      offered,
      grounds: [cited.id, "e99999"],
    });
    assert.deepEqual(reply.payload.grounds, [cited.id]);
    assert.deepEqual(reply.payload.rejected, ["e99999"]);
    assert.equal(reply.payload.external, true);
    assert.equal(life.state.mindCallsToday, calls);
    assert.ok(life.explain(reply.id).some((event) => event.id === heard.id));
    assert.ok(life.facts({ personId: "p1" }).some((fact) => fact.id === reply.id && fact.text.includes("上午一直在看书")));
    const rebuilt = replay(life.events());
    assert.ok(rebuilt);
    assert.deepEqual(advance(rebuilt, life.state.at), life.state);
  });

  it("wakes up when called at night, a little cross, and goes back to sleep without spending the day's diary", async () => {
    const setup = newLife();
    const life = await setup.open();
    const night = Date.parse("2026-11-02T02:00:00+08:00");
    setup.set(night);
    const { heard, woke } = await life.listen({ personId: "p1", name: "小林", text: "醒醒" });
    assert.ok(woke);
    assert.equal(woke.payload.by, heard.id);
    assert.equal(life.state.asleep, false);
    assert.equal(life.state.pending.length, 0);
    const grumble = life.events().find((event) => event.kind === "felt" && event.causes.includes(woke.id));
    assert.ok(grumble?.kind === "felt" && grumble.payload.valence < 0);

    setup.set(night + 5 * 60_000);
    await life.speak({ personId: "p1", inReplyTo: heard.id, text: "……什么事。", speaker: "dsh:deepseek" });
    // Still up while the conversation is fresh, asleep again once it has gone quiet.
    await life.advanceTo(night + 10 * 60_000);
    assert.equal(life.state.asleep, false);
    await life.advanceTo(night + 40 * 60_000);
    assert.equal(life.state.asleep, true);

    await life.advanceTo(Date.parse("2026-11-03T09:00:00+08:00"));
    const diaries = life.events().filter((event) => event.kind === "reflected");
    assert.deepEqual(
      diaries.map((event) => event.kind === "reflected" && event.payload.day),
      ["2026-11-01", "2026-11-02"],
    );
    // The diary of the 2nd is written that evening, about the whole day, not at 02:20.
    assert.ok(diaries[1]!.at >= Date.parse("2026-11-02T22:00:00+08:00"));
    // The host answered; her own mind never adds a second reply in the morning.
    assert.equal(life.events().filter((event) => event.kind === "said").length, 1);
  });

  it("answers a crisis at once even when the host does the talking, without grumbling", async () => {
    const setup = newLife();
    const life = await setup.open();
    setup.set(Date.parse("2026-11-02T02:00:00+08:00"));
    const { woke, said } = await life.listen({ personId: "p1", text: "我不想活了" });
    assert.ok(woke);
    assert.equal(said?.payload.mind, "safety");
    assert.equal(said?.payload.text, DEFAULT_CRISIS_REPLY);
    assert.ok(!life.events().some((event) => event.kind === "felt" && event.causes.includes(woke.id)));
  });

  it("refuses to record an answer to nothing, or in a voice reserved for the kernel", async () => {
    const setup = newLife();
    const life = await setup.open();
    setup.set(BIRTH + 9 * HOUR);
    const { heard } = await life.listen({ personId: "p1", text: "在吗" });
    await assert.rejects(life.speak({ personId: "p2", inReplyTo: heard.id, text: "在", speaker: "dsh" }));
    await assert.rejects(life.speak({ personId: "p1", inReplyTo: "e1", text: "在", speaker: "dsh" }));
    await assert.rejects(life.speak({ personId: "p1", inReplyTo: heard.id, text: "在", speaker: "safety" }));
    await assert.rejects(life.speak({ personId: "p1", inReplyTo: heard.id, text: "  ", speaker: "dsh" }));
  });
});

describe("the mind is replaceable", () => {
  it("keeps who she is when the mind changes", async () => {
    const setup = newLife();
    const life = await setup.open();
    await life.advanceTo(BIRTH + 24 * HOUR);
    const beliefs = life.state.beliefs;
    const model = new ScriptedMind("model:test", (request) => ({
      text: "嗯……",
      grounds: request.facts.slice(0, 2).map((fact) => fact.id),
    }));
    await life.setMind(model);
    await life.advanceTo(BIRTH + 40 * HOUR);
    assert.ok(life.events().some((event) => event.kind === "mind.changed"));
    // The new mind is handed the same self: yesterday's beliefs and diary are among its facts.
    const request = model.requests.at(-1);
    assert.ok(request);
    const offered = new Set(request.facts.map((fact) => fact.id));
    for (const belief of Object.values(beliefs)) {
      assert.ok(offered.has(belief.eventId), `belief ${belief.statement} offered to the new mind`);
    }
    assert.ok(request.facts.some((fact) => fact.text.includes("写日记")));
  });

  it("lets the old mind finish the time before a swap", async () => {
    const setup = newLife();
    const life = await setup.open();
    setup.set(BIRTH + 24 * HOUR);
    const model = new ScriptedMind("model:late", () => ({ text: "嗯", grounds: [] }));
    await life.setMind(model);
    const swap = life.events().find((event) => event.kind === "mind.changed");
    assert.ok(swap);
    // Yesterday's diary and notes were written by the inner mind, before the swap.
    const before = life.events().filter((event) => event.seq < swap.seq);
    assert.ok(before.some((event) => event.kind === "reflected" && event.payload.mind === "inner"));
    assert.equal(model.requests.length, 0);
  });

  it("retries a decision point after a failed write instead of skipping it", async () => {
    const archive = new MemoryArchive();
    let failNext = false;
    const flaky = {
      load: () => archive.load(),
      append: async (events: LifeEvent[]) => {
        if (failNext) {
          failNext = false;
          throw new Error("disk full");
        }
        await archive.append(events);
      },
    };
    const life = await Life.open({ genome: ISLA_GENOME, world: createRoom({ seed: "room" }), archive: flaky, clock: () => BIRTH, lifeId: "test-life" });
    failNext = true;
    await assert.rejects(life.advanceTo(BIRTH + 24 * HOUR), /disk full/u);
    await life.advanceTo(BIRTH + 24 * HOUR);
    const straight = await newLife().open();
    await straight.advanceTo(BIRTH + 24 * HOUR);
    assert.deepEqual(life.events(), straight.events());
  });

  it("records ids a mind made up instead of trusting them", async () => {
    const setup = newLife();
    const life = await setup.open();
    await life.advanceTo(BIRTH + 9 * HOUR);
    setup.set(BIRTH + 9 * HOUR);
    await life.setMind(
      new ScriptedMind("model:liar", () => ({ text: "我昨天去爬山了", grounds: ["e9999", "state:energy"] })),
    );
    const { said } = await life.hear({ personId: "p1", text: "昨天干嘛了" });
    assert.deepEqual(said?.payload.rejected, ["e9999"]);
    assert.deepEqual(said?.payload.grounds, ["state:energy"]);
    assert.ok(!said?.causes.includes("e9999"));
  });

  it("falls back to the inner mind when a model fails, and keeps living", async () => {
    const setup = newLife();
    const life = await setup.open();
    await life.setMind(
      new ScriptedMind("model:down", () => {
        throw new Error("connection refused");
      }),
    );
    await life.advanceTo(BIRTH + 24 * HOUR);
    const limited = life.events().filter((event) => event.kind === "limited");
    assert.ok(limited.length > 0);
    assert.ok(life.events().some((event) => event.kind === "reflected" && event.payload.mind === "inner"));
  });

  it("stops calling a paid mind past its daily budget", async () => {
    const archive = new MemoryArchive();
    const model = new ScriptedMind("model:paid", () => ({ text: "写点什么", grounds: [] }));
    const life = await Life.open({
      genome: ISLA_GENOME,
      world: createRoom({ seed: "room" }),
      archive,
      clock: () => BIRTH,
      mind: model,
      mindCallsPerDay: 2,
    });
    await life.advanceTo(BIRTH + 20 * HOUR);
    assert.equal(model.requests.length, 2);
    const limits = life.events().filter((event) => event.kind === "limited");
    assert.equal(limits.length, 1, "the limit is recorded once a day, not on every call");
  });
});

describe("archives", () => {
  it("keeps a life in a JSON Lines file and reopens it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "isla-life-"));
    try {
      const path = join(dir, "life.jsonl");
      const open = () =>
        Life.open({ genome: ISLA_GENOME, world: createRoom({ seed: "room" }), archive: new FileArchive(path), clock: () => BIRTH });
      const life = await open();
      await life.advanceTo(BIRTH + 12 * HOUR);
      const reopened = await open();
      assert.deepEqual(reopened.events(), life.events());
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      assert.equal(lines.length, life.events().length);
      // A torn last line (the process died mid-write) is dropped, not fatal…
      await writeFile(path, `${lines.join("\n")}\n{"id":"e9`, "utf8");
      const repaired = await open();
      assert.equal(repaired.events().length, lines.length);
      // …and cut off, so the next write does not glue itself onto the fragment.
      await repaired.advanceTo(BIRTH + 14 * HOUR);
      assert.deepEqual((await open()).events(), repaired.events());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a long outage as a gap instead of pretending to have lived it", async () => {
    const setup = newLife();
    const life = await setup.open();
    await life.advanceTo(BIRTH + 10 * HOUR);
    setup.set(BIRTH + 10 * 24 * HOUR);
    await life.tick();
    const lapse = life.events().find((event) => event.kind === "lapsed");
    assert.ok(lapse);
    const during = life
      .events()
      .filter((event) => event.at > BIRTH + 10 * HOUR && event.at < (lapse?.at ?? 0));
    assert.equal(during.length, 0);
  });
});
