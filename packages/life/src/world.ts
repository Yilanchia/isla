import { localTime } from "@isla/core";
import { hashString } from "./random.js";

export interface Book {
  id: string;
  title: string;
  passages: string[];
}

/**
 * The part of reality she can sense and act on. It is deliberately small: a window, the weather
 * outside it, and a shelf of books. A life whose only input is one person's messages becomes
 * that person's echo, so even the smallest world has to exist on its own.
 *
 * A world must be a pure function of time: given the same instant it reports the same weather.
 * That is what lets a life be replayed exactly.
 */
export interface World {
  readonly books: Book[];
  /**
   * `own`: the world makes up its sky from the seed. `host`: the sky out of her window is a real
   * one, and the host tells her when it changes with `perceive({ source: "weather" })`.
   */
  readonly sky?: "own" | "host";
  weather(at: number, timezone: string): string;
  /** What she sees out of the window; `weather` is the sky she last saw, when the host owns it. */
  view(at: number, timezone: string, weather?: string): string;
  /** How pleasant a kind of weather is in itself, before her own taste is added. */
  pleasantness(weather: string): number;
}

const WEATHERS = ["晴", "多云", "阴", "小雨"] as const;

const PLEASANTNESS: Record<string, number> = { 晴: 0.08, 多云: 0.03, 阴: -0.04, 小雨: 0, 雨: -0.02, 大雨: -0.05, 雷雨: -0.05, 雪: 0.05, 雾: -0.03, 霾: -0.06 };

/** Public-domain texts, so the sample world can ship with something worth reading. */
export const SAMPLE_BOOKS: Book[] = [
  {
    id: "zhuangzi",
    title: "庄子",
    passages: [
      "北冥有鱼，其名为鲲。鲲之大，不知其几千里也。化而为鸟，其名为鹏。",
      "吾生也有涯，而知也无涯。以有涯随无涯，殆已！",
      "昔者庄周梦为胡蝶，栩栩然胡蝶也。俄然觉，则蘧蘧然周也。不知周之梦为胡蝶与，胡蝶之梦为周与？",
      "惠子曰：“子非鱼，安知鱼之乐？”庄子曰：“子非我，安知我不知鱼之乐？”",
    ],
  },
  {
    id: "taoyuanming",
    title: "陶渊明诗",
    passages: [
      "结庐在人境，而无车马喧。问君何能尔？心远地自偏。",
      "采菊东篱下，悠然见南山。山气日夕佳，飞鸟相与还。此中有真意，欲辨已忘言。",
      "少无适俗韵，性本爱丘山。误落尘网中，一去三十年。羁鸟恋旧林，池鱼思故渊。",
    ],
  },
  {
    id: "lunyu",
    title: "论语",
    passages: [
      "学而时习之，不亦说乎？有朋自远方来，不亦乐乎？人不知而不愠，不亦君子乎？",
      "子在川上曰：“逝者如斯夫，不舍昼夜。”",
    ],
  },
];

export interface RoomOptions {
  /** Seeds the weather. Two rooms with the same seed have the same sky. */
  seed: string;
  books?: Book[];
  /** `host`: her window looks onto a real sky the host reports; nothing is made up. */
  sky?: "own" | "host";
}

/** A small room with a window and a bookshelf. */
export function createRoom(options: RoomOptions): World {
  const books = options.books ?? SAMPLE_BOOKS;
  const weather = (at: number, timezone: string): string => {
    const time = localTime(at, timezone);
    // Four six-hour slots a day; the sky changes at most four times.
    const slot = Math.floor(time.hour / 6);
    const key = `${options.seed}:${time.year}-${time.month}-${time.day}:${slot}`;
    return WEATHERS[hashString(key) % WEATHERS.length] ?? "晴";
  };
  return {
    books,
    sky: options.sky ?? "own",
    weather,
    view(at, timezone, seen) {
      const time = localTime(at, timezone);
      const sky = seen ?? weather(at, timezone);
      const light =
        time.partOfDay === "深夜" || time.partOfDay === "凌晨"
          ? "外面很黑，只有远处几盏灯"
          : time.partOfDay === "傍晚"
            ? "天色慢慢暗下来"
            : time.partOfDay === "晚上"
              ? "楼下的路灯亮了"
              : "楼下有人走过";
      const sound = /雨/u.test(sky) ? "，雨点打在窗台上" : sky === "晴" ? "，阳光落在窗框上" : sky === "雪" ? "，雪落在窗台上" : "";
      return `${light}${sound}`;
    },
    pleasantness(kind) {
      return PLEASANTNESS[kind] ?? 0;
    },
  };
}

export function describeWeather(kind: string): string {
  switch (kind) {
    case "小雨":
      return "外面下起了小雨";
    case "雨":
      return "外面下雨了";
    case "大雨":
      return "外面下起了大雨";
    case "雷雨":
      return "外面打雷下雨了";
    case "雪":
      return "外面下雪了";
    case "雾":
      return "外面起雾了";
    case "霾":
      return "外面起霾了";
    case "阴":
      return "天阴了下来";
    case "多云":
      return "云多了起来";
    case "晴":
      return "天晴了";
    default:
      return `外面${kind}`;
  }
}
