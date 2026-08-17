// All labels are rendered in the requested location's timezone, not the
// user's. Formatters are cached per (timezone, options) since
// Intl.DateTimeFormat construction is expensive.

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + "|" + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts });
    cache.set(key, f);
  }
  return f;
}

export function formatClock(tz: string, tSec: number): string {
  return formatter(tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(tSec * 1000),
  );
}
export function formatHour(tz: string, tSec: number): string {
  return formatter(tz, { hour: "2-digit", hourCycle: "h23" }).format(new Date(tSec * 1000));
}

/** Full label used in tooltips: "Sat 23 Aug, 15:00". */
export function formatFull(tz: string, tSec: number): string {
  return formatter(tz, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(tSec * 1000));
}

interface LocalWallClock {
  /** days since epoch of the location-local date */
  serialDay: number;
  secOfDay: number;
  year: number;
  month: number;
  day: number;
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function localWallClock(tz: string, tSec: number): LocalWallClock {
  const parts = formatter(tz, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(tSec * 1000));
  let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, weekday = "";
  for (const part of parts) {
    switch (part.type) {
      case "year": year = Number(part.value); break;
      case "month": month = Number(part.value); break;
      case "day": day = Number(part.value); break;
      case "hour": hour = Number(part.value); break;
      case "minute": minute = Number(part.value); break;
      case "second": second = Number(part.value); break;
      case "weekday": weekday = part.value; break;
    }
  }
  return {
    serialDay: Math.floor(Date.UTC(year, month - 1, day) / 86_400_000),
    secOfDay: hour * 3600 + minute * 60 + second,
    year,
    month,
    day,
    weekday: Math.max(0, WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number])),
  };
}

/** Day label relative to "today" in the location's timezone. */
export function formatDayLabel(tz: string, tSec: number, nowSec: number): string {
  const here = localWallClock(tz, tSec);
  const today = localWallClock(tz, nowSec);
  const delta = here.serialDay - today.serialDay;
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  return `${WEEKDAYS[here.weekday]} ${here.day}`;
}

/** Unix second of the local midnight starting the day that contains tSec.
 * Iterated twice to absorb the zone offset and any DST shift in secOfDay. */
export function localMidnight(tz: string, tSec: number): number {
  const target = localWallClock(tz, tSec).serialDay;
  let guess = target * 86_400;
  for (let i = 0; i < 2; i++) {
    const wall = localWallClock(tz, guess);
    guess += (target - wall.serialDay) * 86_400 - wall.secOfDay;
  }
  return guess;
}
