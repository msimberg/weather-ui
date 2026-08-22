import { formatDayLabel, formatDayShort, localMidnight } from "./time";
import type { DayPoint, HourPoint, MinutePoint, WeatherPayload } from "./types";

// prepare() converts the API payload into the render model: domain bounds,
// night shading intervals, and per-day groupings. It runs once per fetch, so
// the render loop only does geometry.

export interface CloudLayers {
  time: number[];
  low: number[];
  mid: number[];
  high: number[];
}

export interface NightSpan {
  startSec: number;
  endSec: number;
}

export interface DayGroup {
  /** local-midnight unix second at the location */
  startSec: number;
  endSec: number;
  /** Relative label ("Today", "Tomorrow", "Yesterday", or weekday + day). */
  label: string;
  /** Short month-free label ("Mon 12") used when day labels rotate. */
  short: string;
  day: DayPoint;
}

export interface Domains {
  tempLo: number;
  tempHi: number;
  windMax: number;
  precipMax: number;
  /** Max UV index across all hours, used so the peak fills the band. */
  uvMax: number;
}

export interface Prepared {
  timezone: string;
  offsetH: number;
  elevation?: number;
  hours: HourPoint[];
  minutes: MinutePoint[];
  days: DayPoint[];
  cloudLayers?: CloudLayers;
  dayGroups: DayGroup[];
  nights: NightSpan[];
  domains: Domains;
  currently?: HourPoint;
  summaryMinutely?: string;
  summaryDaily?: string;
  summaryHourly?: string;
  alerts: WeatherPayload["alerts"];
  warnings: string[];
  sources: string[];
  apiVersion?: string;
  fetchedAtSec: number;
}

export function prepare(payload: WeatherPayload, nowSec: number): Prepared {
  const tz = payload.timezone;
  const hours = (payload.hourly?.data ?? []).slice().sort((a, b) => a.time - b.time);
  const minutes = (payload.minutely?.data ?? []).slice().sort((a, b) => a.time - b.time);
  const days = (payload.daily?.data ?? []).slice().sort((a, b) => a.time - b.time);

  // endSec is the next day's midnight: DST days are not always 86400 seconds.
  const midnights = days.map((day) => localMidnight(tz, day.time));
  const dayGroups: DayGroup[] = days.map((day, i) => ({
    startSec: midnights[i],
    endSec: midnights[i + 1] ?? midnights[i] + 86_400,
    label: formatDayLabel(tz, day.time, nowSec),
    short: formatDayShort(tz, day.time),
    day,
  }));

  // Night intervals come from sunset/sunrise of consecutive days. Each day
  // emits its pre-dawn (midnight to sunrise) and its main night (sunset to
  // next sunrise); those overlap across midnight, so merge them before the
  // renderer fills them. Without the merge the post-midnight half of every
  // night is painted twice and reads darker than the pre-midnight half.
  const rawNights: NightSpan[] = [];
  for (let i = 0; i < dayGroups.length; i++) {
    const day = dayGroups[i].day;
    if (day.sunsetTime) {
      const next = dayGroups[i + 1]?.day;
      if (next?.sunriseTime) {
        rawNights.push({ startSec: day.sunsetTime, endSec: next.sunriseTime });
      }
    }
    if (day.sunriseTime && day.sunsetTime && day.sunriseTime > dayGroups[i].startSec) {
      rawNights.push({ startSec: dayGroups[i].startSec, endSec: day.sunriseTime });
    }
  }
  rawNights.sort((a, b) => a.startSec - b.startSec);
  const nights: NightSpan[] = [];
  for (const sp of rawNights) {
    const last = nights[nights.length - 1];
    if (last && sp.startSec <= last.endSec) last.endSec = Math.max(last.endSec, sp.endSec);
    else nights.push({ startSec: sp.startSec, endSec: sp.endSec });
  }

  let tempLo = Infinity;
  let tempHi = -Infinity;
  let windMax = 0;
  let precipMax = 0;
  let uvMax = 0;
  // Collect gusts/speeds across the whole range so the wind band can be
  // scaled by a percentile instead of a single outlier: with a calm location
  // and one dominant far-future gust, the global max stretches the scale so
  // the visible line hugs the bottom with a large empty band above.
  const windSamples: number[] = [];
  const widen = (v: number | undefined, lo: boolean) => {
    if (v === undefined || Number.isNaN(v)) return;
    if (lo) tempLo = Math.min(tempLo, v);
    else tempHi = Math.max(tempHi, v);
  };
  for (const h of hours) {
    widen(h.temperature, true);
    widen(h.temperature, false);
    widen(h.apparentTemperature, true);
    widen(h.apparentTemperature, false);
    const g = h.windGust ?? 0;
    const s = h.windSpeed ?? 0;
    if (g > 0) windSamples.push(g);
    if (s > 0) windSamples.push(s);
    precipMax = Math.max(precipMax, h.precipIntensity ?? 0);
    if (h.uvIndex !== undefined) uvMax = Math.max(uvMax, h.uvIndex);
  }
  for (const d of days) {
    widen(d.temperatureHigh ?? d.temperatureMax, false);
    widen(d.temperatureLow ?? d.temperatureMin, true);
    widen(d.apparentTemperatureLow ?? d.apparentTemperatureMin, true);
    precipMax = Math.max(precipMax, d.precipIntensityMax ?? 0);
  }
  if (!Number.isFinite(tempLo) || !Number.isFinite(tempHi)) {
    tempLo = 0;
    tempHi = 1;
  }
  const margin = Math.max(1.0, (tempHi - tempLo) * 0.08);
  tempLo -= margin;
  tempHi += margin;
  // Wind band scale = 95th percentile of all gust/speed samples, not the
  // global max. A single dominant far-future gust (often faded to 0.35 alpha
  // at the compressed edge) otherwise stretches the scale so the visible line
  // hugs the bottom. The 95th keeps the bulk of the range; rare outliers above
  // it clip at the top of the data area (the renderer clamps) instead of
  // shrinking everything below.
  windMax =
    windSamples.length > 0
      ? windSamples.slice().sort((a, b) => a - b)[Math.floor(windSamples.length * 0.95)]
      : 0;
  return {
    timezone: tz,
    offsetH: payload.offset,
    elevation: payload.elevation,
    hours,
    minutes,
    days,
    cloudLayers: parseCloudLayers(payload.cloudLayers),
    dayGroups,
    nights,
    domains: {
      tempLo,
      tempHi,
      // 95th percentile (computed above) plus 10% headroom so values near it
      // don't sit exactly at the band top; rare gusts above clip there. The
      // wind band uses a sqrt display scale, so this only sets the bar at
      // which a value saturates.
      windMax: windMax * 1.1 || 1,
      // sqrt display scale: the domain only sets the bar at which a value
      // saturates visually. The floor is low so light rain still fills most of
      // the band instead of sitting at the bottom with empty space above.
      precipMax: Math.max(precipMax, 1.0),
      uvMax: Math.max(uvMax + 1, 3),
    },
    currently: payload.currently,
    summaryMinutely: payload.minutely?.summary,
    summaryDaily: payload.daily?.summary,
    summaryHourly: payload.hourly?.summary,
    alerts: payload.alerts,
    warnings: payload.meta?.warnings ?? [],
    sources: payload.flags?.sources ?? [],
    apiVersion: payload.flags?.version,
    fetchedAtSec: nowSec,
  };
}

function parseCloudLayers(raw: WeatherPayload["cloudLayers"]): CloudLayers | undefined {
  if (!raw || !Array.isArray(raw.time)) return undefined;
  if (raw.time.length === 0) return undefined;
  return {
    time: raw.time.map(Number),
    low: (raw.low ?? []).map(Number),
    mid: (raw.mid ?? []).map(Number),
    high: (raw.high ?? []).map(Number),
  };
}

const MS_PER_DAY = 86_400_000;
export const FUTURE_DAYS = 7;

export function axisRanges(pastDays: number): { pastMs: number; futureMs: number } {
  return { pastMs: pastDays * MS_PER_DAY, futureMs: FUTURE_DAYS * MS_PER_DAY };
}

export interface Sample {
  kind: "minute" | "hour" | "day";
  hour?: HourPoint;
  minute?: MinutePoint;
  day?: DayPoint;
}

function nearest<T extends { time: number }>(list: T[], tSec: number): T | undefined {
  if (list.length === 0) return undefined;
  let lo = 0;
  let hi = list.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time <= tSec) lo = mid;
    else hi = mid;
  }
  return tSec - list[lo].time <= list[hi].time - tSec ? list[lo] : list[hi];
}

/** Pick the most detailed sample available near tSec. Minutely only applies
 * inside its (roughly 1 hour) window; days only when no hour is close. */
export function sampleAt(model: Prepared, tSec: number): Sample | null {
  const hour = nearest(model.hours, tSec);
  const day = nearest(model.days, tSec);
  const minute =
    model.minutes.length > 0 &&
    tSec >= model.minutes[0].time - 900 &&
    tSec <= model.minutes[model.minutes.length - 1].time + 900
      ? nearest(model.minutes, tSec)
      : undefined;
  if (minute && Math.abs(minute.time - tSec) < 1800) {
    return { kind: "minute", minute, hour, day };
  }
  if (hour && Math.abs(hour.time - tSec) < 5400) {
    return { kind: "hour", hour, day };
  }
  if (day) {
    return { kind: "day", day };
  }
  return hour ? { kind: "hour", hour, day } : null;
}
