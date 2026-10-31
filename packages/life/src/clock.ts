import { localTime } from "@isla/core";

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** How far the zone's wall clock is ahead of UTC at an instant, in ms. */
export function zoneOffset(at: number, timezone: string): number {
  const time = localTime(at, timezone);
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute);
  return wall - Math.floor(at / MINUTE) * MINUTE;
}

/** The first instant strictly after `after` at which the local clock reads `hour:00`. */
export function nextLocalHour(after: number, hour: number, timezone: string): number {
  const offset = zoneOffset(after, timezone);
  const wall = new Date(after + offset);
  let target = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hour);
  if (target <= after + offset) target += DAY;
  const guess = target - offset;
  // Across a daylight-saving change the offset at the target differs from the offset now.
  const corrected = target - zoneOffset(guess, timezone);
  if (corrected > after) return corrected;
  // Never return a moment at or before `after`, or a caller stepping through time would stall.
  return guess > after ? guess : guess + DAY;
}

/** Whether a local hour falls inside the waking part of a sleep/wake cycle. */
export function isWakingHour(hour: number, wakeHour: number, sleepHour: number): boolean {
  return wakeHour < sleepHour
    ? hour >= wakeHour && hour < sleepHour
    : hour >= wakeHour || hour < sleepHour;
}

export function clockLabel(at: number, timezone: string): string {
  const time = localTime(at, timezone);
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}
