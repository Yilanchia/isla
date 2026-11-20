import type { LifeEvent } from "./events.js";
import { dayKey, fold, type LifeState } from "./state.js";

/**
 * How alive a life has been, read off its log. Nothing here is a judgement of a single day; it
 * asks whether the life keeps moving: does her diary say new things, does her notebook repeat
 * itself, does she still find things out about herself, does something new still reach her, and
 * does what she says about herself fit what she has been through.
 *
 * It is a measurement for hosts and evals. The kernel never reads it.
 */
export interface DayVitals {
  /** Local date, `YYYY-MM-DD`. */
  day: string;
  /** Days since birth, from 0. */
  age: number;
  diarySentences: number;
  /** Diary sentences never written before, ignoring numbers (“写了 5 次” is not new after “写了 6 次”). */
  newDiarySentences: number;
  notes: number;
  newNotes: number;
  /** A belief formed or changed. */
  beliefChanges: number;
  /** Things met for the first time: a passage, an item, a perceived thing, a person. */
  firsts: number;
  /** At bedtime, how long she had wanted company without having any, in days. */
  unmetConnectionDays: number;
  /** Mood at bedtime, from the state. */
  moodAtBedtime?: number;
  /** She has wanted company for three days or more and still goes to bed in a good mood. */
  unmetButFine: boolean;
}

export interface WeekVitals {
  /** Week since birth, from 1. */
  week: number;
  days: number;
  /** Share of diary sentences that were new, 0..1. */
  diaryNovelty: number;
  noteNovelty: number;
  beliefChanges: number;
  firsts: number;
  unmetButFineDays: number;
}

export interface Vitals {
  days: DayVitals[];
  weeks: WeekVitals[];
}

const UNMET = 0.85;
const FINE = 0.08;

/** Strips numbers and spacing, so a sentence that only changed a count is not counted as new. */
function normalize(text: string): string {
  return text.replace(/[\d\s]+/gu, "").replace(/[，。、；：！？「」《》“”…—]/gu, "");
}

function sentencesOf(diary: string): string[] {
  return diary
    .split(/[。！？]/u)
    .map(normalize)
    .filter((sentence) => sentence.length > 1);
}

function firstKey(event: LifeEvent): string | undefined {
  switch (event.kind) {
    case "activity.started": {
      const material = event.payload.material;
      if (material?.kind === "passage") return `passage:${material.text}`;
      if (material?.kind === "item") return `item:${material.shelf}:${material.item}`;
      return undefined;
    }
    case "perceived":
      return `perceived:${event.payload.source}:${event.payload.detail ?? event.payload.what}`;
    case "heard":
      return `person:${event.payload.personId}`;
    default:
      return undefined;
  }
}

export function measureLife(events: LifeEvent[]): Vitals {
  const days = new Map<string, DayVitals>();
  const seenSentences = new Set<string>();
  const seenNotes = new Set<string>();
  const seenFirsts = new Set<string>();
  let state: LifeState | undefined;
  let born = 0;
  let unmetDays = 0;
  let lastBedtimeDay: string | undefined;
  for (const event of events) {
    state = fold(state, event);
    if (event.kind === "born") born = Date.parse(`${dayKey(event.at, state.genome.timezone)}T00:00:00Z`);
    const key = dayKey(event.at, state.genome.timezone);
    let day = days.get(key);
    if (!day) {
      day = {
        day: key,
        age: Math.round((Date.parse(`${key}T00:00:00Z`) - born) / 86_400_000),
        diarySentences: 0,
        newDiarySentences: 0,
        notes: 0,
        newNotes: 0,
        beliefChanges: 0,
        firsts: 0,
        unmetConnectionDays: 0,
        unmetButFine: false,
      };
      days.set(key, day);
    }
    const first = firstKey(event);
    if (first && !seenFirsts.has(first)) {
      seenFirsts.add(first);
      day.firsts += 1;
    }
    switch (event.kind) {
      case "reflected":
        for (const sentence of sentencesOf(event.payload.diary)) {
          day.diarySentences += 1;
          if (!seenSentences.has(sentence)) {
            seenSentences.add(sentence);
            day.newDiarySentences += 1;
          }
        }
        break;
      case "wrote": {
        const note = normalize(event.payload.text);
        day.notes += 1;
        if (!seenNotes.has(note)) {
          seenNotes.add(note);
          day.newNotes += 1;
        }
        break;
      }
      case "belief":
        day.beliefChanges += 1;
        break;
      case "slept":
        // One bedtime per day counts; a nap or being put back to sleep at night does not.
        if (lastBedtimeDay === key) break;
        lastBedtimeDay = key;
        unmetDays = state.drives.connection >= UNMET ? unmetDays + 1 : 0;
        day.unmetConnectionDays = unmetDays;
        day.moodAtBedtime = Math.round(state.mood.valence * 1000) / 1000;
        day.unmetButFine = unmetDays >= 3 && state.mood.valence > FINE;
        break;
      default:
        break;
    }
  }
  const list = [...days.values()].sort((left, right) => left.age - right.age);
  const weeks = new Map<number, DayVitals[]>();
  for (const day of list) {
    const week = Math.floor(day.age / 7) + 1;
    weeks.set(week, [...(weeks.get(week) ?? []), day]);
  }
  const share = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000);
  const sum = (items: DayVitals[], pick: (day: DayVitals) => number) => items.reduce((total, day) => total + pick(day), 0);
  return {
    days: list,
    weeks: [...weeks.entries()].map(([week, items]) => ({
      week,
      days: items.length,
      diaryNovelty: share(sum(items, (day) => day.newDiarySentences), sum(items, (day) => day.diarySentences)),
      noteNovelty: share(sum(items, (day) => day.newNotes), sum(items, (day) => day.notes)),
      beliefChanges: sum(items, (day) => day.beliefChanges),
      firsts: sum(items, (day) => day.firsts),
      unmetButFineDays: items.filter((day) => day.unmetButFine).length,
    })),
  };
}

/** A small table, one line per week, for logs and the command line. */
export function formatVitals(vitals: Vitals): string {
  const rows = vitals.weeks.map(
    (week) =>
      `${String(week.week).padStart(4)}  ${String(week.days).padStart(4)}  ${week.diaryNovelty.toFixed(2).padStart(6)}  ${week.noteNovelty.toFixed(2).padStart(6)}  ${String(week.beliefChanges).padStart(6)}  ${String(week.firsts).padStart(6)}  ${String(week.unmetButFineDays).padStart(10)}`,
  );
  return [" week  days   diary   notes  belief  firsts  unmet+fine", ...rows].join("\n");
}
