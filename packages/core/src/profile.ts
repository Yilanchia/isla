import { z } from "zod";
import { PARTS_OF_DAY } from "./time.js";

const shortText = (max: number) => z.string().trim().min(1).max(max);
const textList = (maxItems: number, maxLength = 200) => z.array(shortText(maxLength)).max(maxItems).default([]);

export const speechStyleSchema = z.object({
  /** Overall register / tone, e.g. "很口语，像微信上和老朋友聊天". */
  register: z.string().trim().max(500).default(""),
  /** Typical reply length, e.g. "一般一到两句". */
  typicalLength: z.string().trim().max(300).default(""),
  catchphrases: textList(20, 50),
  /** 语气词 such as 啊、呀、嘛. */
  fillers: textList(30, 20),
  emojiFrequency: z.enum(["never", "rare", "sometimes", "often"]).default("rare"),
  punctuationHabits: z.string().trim().max(500).default(""),
  bannedPhrases: textList(60, 100),
});

export const companionProfileSchema = z.object({
  name: shortText(40),
  /** Gender / identity description in the companion's own terms. */
  identity: z.string().trim().max(500).default(""),
  age: z.number().int().min(0).max(200).optional(),
  /** 关系定位: 朋友 / 恋人 / 家人 / 导师 or any free text. Empty means 朋友. */
  relationship: z.string().trim().max(50).default(""),
  backstory: z.string().trim().max(3000).default(""),
  traits: textList(20, 100),
  values: textList(20, 200),
  opinions: z
    .array(z.object({ topic: shortText(100), stance: shortText(300) }))
    .max(30)
    .default([]),
  speechStyle: speechStyleSchema.default({}),
  quirks: textList(20),
  likes: textList(30, 100),
  dislikes: textList(30, 100),
  boundaries: textList(20, 300),
  /** Rough schedule by part of day, used to say what the companion is "doing" right now. */
  dailyRoutine: z
    .array(z.object({ period: z.enum(PARTS_OF_DAY), activity: shortText(200) }))
    .max(16)
    .default([]),
  /** Style references for the model; content should not be copied verbatim. */
  exampleDialogues: z
    .array(z.object({ user: shortText(500), companion: shortText(800) }))
    .max(12)
    .default([]),
  /** 自由描述: a free-form paragraph for users who prefer writing prose over filling fields. */
  freeform: z.string().trim().max(3000).default(""),
});

export type CompanionProfile = z.output<typeof companionProfileSchema>;
export type CompanionProfileInput = z.input<typeof companionProfileSchema>;
export type SpeechStyle = CompanionProfile["speechStyle"];

/** Parses unknown JSON into a profile, or undefined when it is not a valid profile. */
export function parseCompanionProfile(value: unknown): CompanionProfile | undefined {
  const parsed = companionProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Upper bound on the total text of a user-written profile (all string fields added up). */
export const MAX_PROFILE_CHARS = 6000;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Neutralizes persona text so it cannot imitate the prompt's own structure: removes the
 * [[COMPANION_*]] protocol markers and any [[ ]] brackets, heading markers (our section titles
 * start with "## "), code fences, invisible/bidi control characters, and long blank runs.
 */
export function sanitizePersonaText(value: string): string {
  return value
    .replace(/\[\[\s*COMPANION_[A-Z_]*\s*\]\]/giu, "")
    .replace(/\[\[/gu, "[")
    .replace(/\]\]/gu, "]")
    .replace(/^[ \t]*#{1,6}[ \t]*/gmu, "")
    .replace(/```+/gu, "")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

const clean = (value: string): string => sanitizePersonaText(value);
const cleanList = (values: string[]): string[] => values.map(clean).filter(Boolean);

/** Returns a copy of the profile with every text field sanitized and emptied entries dropped. */
export function sanitizeProfile(profile: CompanionProfile): CompanionProfile {
  return {
    ...profile,
    name: clean(profile.name) || "未命名",
    identity: clean(profile.identity),
    relationship: clean(profile.relationship),
    backstory: clean(profile.backstory),
    traits: cleanList(profile.traits),
    values: cleanList(profile.values),
    opinions: profile.opinions
      .map((opinion) => ({ topic: clean(opinion.topic), stance: clean(opinion.stance) }))
      .filter((opinion) => opinion.topic && opinion.stance),
    speechStyle: {
      ...profile.speechStyle,
      register: clean(profile.speechStyle.register),
      typicalLength: clean(profile.speechStyle.typicalLength),
      catchphrases: cleanList(profile.speechStyle.catchphrases),
      fillers: cleanList(profile.speechStyle.fillers),
      punctuationHabits: clean(profile.speechStyle.punctuationHabits),
      bannedPhrases: cleanList(profile.speechStyle.bannedPhrases),
    },
    quirks: cleanList(profile.quirks),
    likes: cleanList(profile.likes),
    dislikes: cleanList(profile.dislikes),
    boundaries: cleanList(profile.boundaries),
    dailyRoutine: profile.dailyRoutine
      .map((entry) => ({ period: entry.period, activity: clean(entry.activity) }))
      .filter((entry) => entry.activity),
    exampleDialogues: profile.exampleDialogues
      .map((dialogue) => ({ user: clean(dialogue.user), companion: clean(dialogue.companion) }))
      .filter((dialogue) => dialogue.user && dialogue.companion),
    freeform: clean(profile.freeform),
  };
}

/** Total characters across all text fields of a profile. */
export function profileTextLength(profile: CompanionProfile): number {
  let total = 0;
  const visit = (value: unknown): void => {
    if (typeof value === "string") total += value.length;
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(profile);
  return total;
}

export type ProfileValidation =
  | { ok: true; profile: CompanionProfile }
  | { ok: false; error: "invalid_profile" | "profile_too_long"; details?: unknown };

/** Validates, sanitizes and size-checks a user-supplied profile. */
export function validateUserProfile(value: unknown): ProfileValidation {
  const parsed = companionProfileSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: "invalid_profile", details: parsed.error.flatten() };
  }
  const profile = sanitizeProfile(parsed.data);
  const length = profileTextLength(profile);
  if (length > MAX_PROFILE_CHARS) {
    return { ok: false, error: "profile_too_long", details: { length, max: MAX_PROFILE_CHARS } };
  }
  return { ok: true, profile };
}
