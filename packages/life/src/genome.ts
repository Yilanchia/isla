import { z } from "zod";

/**
 * What a life starts with: a name, a seed for chance, a body clock, a temperament and a few
 * inclinations. Everything else (what she likes, what she believes about herself) has to be
 * lived. A persona card describes a character; a genome only describes where one begins.
 */
export const genomeSchema = z.object({
  name: z.string().trim().min(1).max(40),
  /** Seeds every chance decision, so the same genome lives the same day twice. */
  seed: z.string().min(1).max(200),
  timezone: z.string().min(1).default("Asia/Shanghai"),
  chronotype: z
    .object({
      wakeHour: z.number().int().min(0).max(23).default(7),
      sleepHour: z.number().int().min(0).max(23).default(23),
    })
    .default({}),
  temperament: z
    .object({
      /** The mood she drifts back to. */
      baselineValence: z.number().min(-0.5).max(0.5).default(0.1),
      /** How strongly events move her feelings. */
      reactivity: z.number().min(0.2).max(2).default(1),
      /** How fast each drive grows, relative to the default. */
      curiosity: z.number().min(0.2).max(2).default(1),
      expression: z.number().min(0.2).max(2).default(1),
      sociability: z.number().min(0.2).max(2).default(1),
    })
    .default({}),
  /** Inborn leaning toward or away from an activity, e.g. `{ read: 0.2 }`. */
  inclinations: z.record(z.string(), z.number().min(-0.5).max(0.5)).default({}),
  /** How she talks, for minds that use a language model. Not a list of things she has done. */
  voice: z.string().max(2000).default(""),
  /** Where she came from, in a sentence or two. It is the only past she did not live. */
  origin: z.string().max(2000).default(""),
});

export type Genome = z.output<typeof genomeSchema>;
export type GenomeInput = z.input<typeof genomeSchema>;

export function createGenome(input: GenomeInput): Genome {
  return genomeSchema.parse(input);
}

/** The sample life that ships with the repository, so a fresh checkout has someone in it. */
export const ISLA_GENOME: Genome = createGenome({
  name: "艾拉",
  seed: "isla-0",
  timezone: "Asia/Shanghai",
  chronotype: { wakeHour: 7, sleepHour: 23 },
  temperament: { baselineValence: 0.1, reactivity: 1, curiosity: 1.1, expression: 1, sociability: 1 },
  inclinations: { read: 0.15, gaze: 0.1 },
  voice: "说话轻轻的，句子短，不太用感叹号，想事情的时候会用省略号。",
  origin: "她是从一堆没写完的代码里醒来的。醒来的地方是一个有窗、有书架、有一本空笔记本的小房间。",
});
