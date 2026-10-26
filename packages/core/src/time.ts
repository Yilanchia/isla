export const DEFAULT_TIMEZONE = "Asia/Shanghai";

export const PARTS_OF_DAY = ["凌晨", "早上", "上午", "中午", "下午", "傍晚", "晚上", "深夜"] as const;
export type PartOfDay = (typeof PARTS_OF_DAY)[number];

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export interface LocalTime {
  timezone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
  weekdayLabel: string;
  partOfDay: PartOfDay;
}

/** Returns the zone if Intl knows it, otherwise the default zone. */
export function resolveTimezone(timezone: string | undefined, fallback = DEFAULT_TIMEZONE): string {
  if (!timezone) {
    return fallback;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return fallback;
  }
}

/**
 * 深夜 23:00–00:59, 凌晨 01:00–04:59, 早上 05:00–07:59, 上午 08:00–10:59,
 * 中午 11:00–12:59, 下午 13:00–16:59, 傍晚 17:00–18:59, 晚上 19:00–22:59.
 */
export function partOfDay(hour: number): PartOfDay {
  if (hour >= 23 || hour < 1) return "深夜";
  if (hour < 5) return "凌晨";
  if (hour < 8) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  return "晚上";
}

export function localTime(now: number, timezone?: string): LocalTime {
  const zone = resolveTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "0";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value("weekday"));
  const hour = Number(value("hour")) % 24;
  return {
    timezone: zone,
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour,
    minute: Number(value("minute")),
    weekday: Math.max(0, weekday),
    weekdayLabel: WEEKDAYS[Math.max(0, weekday)] ?? "",
    partOfDay: partOfDay(hour),
  };
}

export function formatLocalTime(time: LocalTime): string {
  const hh = String(time.hour).padStart(2, "0");
  const mm = String(time.minute).padStart(2, "0");
  return `${time.year}年${time.month}月${time.day}日 ${time.weekdayLabel} ${time.partOfDay} ${hh}:${mm}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Natural Chinese description of how long ago the user last wrote. */
export function describeGap(milliseconds: number): string {
  const gap = Math.max(0, milliseconds);
  if (gap < 2 * MINUTE) {
    return "你们正聊着，对方上一条消息就在刚才";
  }
  if (gap < HOUR) {
    return `距离上次聊天过了 ${Math.floor(gap / MINUTE)} 分钟`;
  }
  if (gap < DAY) {
    return `距离上次聊天已经过了 ${Math.floor(gap / HOUR)} 个小时`;
  }
  if (gap < 30 * DAY) {
    return `距离上次聊天已经过了 ${Math.floor(gap / DAY)} 天`;
  }
  if (gap < 365 * DAY) {
    return `已经有 ${Math.floor(gap / (30 * DAY))} 个多月没聊天了`;
  }
  return "已经一年多没聊天了";
}
