import type { EmotionDelta, EmotionEvent, EmotionState } from "./types.js";

/** The six dimensions the runtime keeps. P/A/D describe the mood, T/B the relationship, E the energy. */
export const EMOTION_DIMENSIONS = [
  "pleasure",
  "arousal",
  "dominance",
  "trust",
  "bonding",
  "energy",
] as const;

export type EmotionDimension = (typeof EMOTION_DIMENSIONS)[number];

/** `energy` lives in [0, 1]; the other five are bipolar, in [-1, 1]. */
function clampDimension(dimension: EmotionDimension, value: number): number {
  if (dimension === "energy") {
    return Math.min(1, Math.max(0, value));
  }
  return Math.min(1, Math.max(-1, value));
}

export const DEFAULT_EMOTION_STATE: EmotionState = {
  pleasure: 0.1,
  arousal: 0,
  dominance: 0,
  trust: 0,
  bonding: 0,
  energy: 0.7,
  updatedAt: 0,
};

/**
 * Per-dimension tuning. Different dimensions should not decay at the same rate: energy recovers
 * within hours, while trust and bonding should move slowly. The default keeps the historic
 * single rate so existing behaviour does not change; pass your own config to tune it.
 */
export interface EmotionConfig {
  /** Exponential decay per second, per dimension. */
  decayPerSecond: Record<EmotionDimension, number>;
  /** The state the dimensions drift back to. */
  base: EmotionState;
  /** How strongly an event moves a dimension, given its importance in [0, 1]. */
  gain: (importance: number) => number;
}

const DEFAULT_DECAY = 0.00002;

export const DEFAULT_EMOTION_CONFIG: EmotionConfig = {
  decayPerSecond: {
    pleasure: DEFAULT_DECAY,
    arousal: DEFAULT_DECAY,
    dominance: DEFAULT_DECAY,
    trust: DEFAULT_DECAY,
    bonding: DEFAULT_DECAY,
    energy: DEFAULT_DECAY,
  },
  base: DEFAULT_EMOTION_STATE,
  gain: (importance) => 0.35 + importance * 0.65,
};

/**
 * A starting point for companion tuning: moods fade within a day, energy comes back faster,
 * trust and bonding move slowly enough to feel earned. Not the default, because it changes
 * the shape of the curve and should be an explicit choice.
 */
export const TUNED_EMOTION_CONFIG: EmotionConfig = {
  decayPerSecond: {
    pleasure: DEFAULT_DECAY * 2,
    arousal: DEFAULT_DECAY * 3,
    dominance: DEFAULT_DECAY,
    trust: DEFAULT_DECAY / 4,
    bonding: DEFAULT_DECAY / 6,
    energy: DEFAULT_DECAY * 6,
  },
  base: DEFAULT_EMOTION_STATE,
  gain: (importance) => 0.35 + importance * 0.65,
};

export interface EmotionUpdateOptions {
  now?: number;
  /** Legacy single rate applied to every dimension; overrides the per-dimension config. */
  decayRatePerSecond?: number;
  /** Legacy base state; overrides the config's base. */
  base?: EmotionState;
  config?: EmotionConfig;
}

export function updateEmotion(
  current: EmotionState,
  event: EmotionEvent,
  options: EmotionUpdateOptions = {},
): EmotionState {
  const now = options.now ?? Date.now();
  const config = options.config ?? DEFAULT_EMOTION_CONFIG;
  const base = options.base ?? config.base;
  const elapsedSeconds = Math.max(0, (now - current.updatedAt) / 1000);
  const importance = Math.min(1, Math.max(0, event.importance));
  const gain = config.gain(importance);
  const next = { ...current };

  for (const dimension of EMOTION_DIMENSIONS) {
    const rate = options.decayRatePerSecond ?? config.decayPerSecond[dimension];
    const decay = Math.exp(-rate * elapsedSeconds);
    const currentValue = current[dimension];
    const baseValue = base[dimension];
    const delta = event.delta[dimension] ?? 0;
    next[dimension] = clampDimension(
      dimension,
      currentValue * decay + baseValue * (1 - decay) + delta * gain,
    );
  }
  next.updatedAt = now;
  return next;
}

/** Applies only the time-based decay toward the base state, as of `now`. */
export function decayEmotion(
  current: EmotionState,
  now: number,
  options: Omit<EmotionUpdateOptions, "now"> = {},
): EmotionState {
  return updateEmotion(current, { delta: {}, importance: 0, reason: "decay" }, { ...options, now });
}

export interface EmotionLabelThresholds {
  strong: number;
  weak: number;
  tired: number;
}

const DEFAULT_LABEL_THRESHOLDS: EmotionLabelThresholds = {
  strong: 0.35,
  weak: 0.35,
  tired: -0.35,
};

export function emotionLabel(
  state: EmotionState,
  thresholds: Partial<EmotionLabelThresholds> = {},
): string {
  const { strong, weak, tired } = { ...DEFAULT_LABEL_THRESHOLDS, ...thresholds };
  if (state.energy < tired) {
    return "疲惫";
  }
  if (state.pleasure >= strong && state.arousal >= 0.45) {
    return "兴奋";
  }
  if (state.pleasure >= strong) {
    return "开心";
  }
  if (state.pleasure <= -weak && state.arousal >= 0.45) {
    return "紧张";
  }
  if (state.pleasure <= -weak) {
    return "低落";
  }
  if (state.arousal <= -0.35) {
    return "平静";
  }
  return "平稳";
}
