import type { Units } from "./types";

// Pirate Weather converts values server-side; these tables only describe what
// a value unit means for display. "si" is the baseline; ca swaps wind to km/h,
// uk/uk2 swap wind and visibility to mph/miles, us is imperial.

export function tempUnit(u: Units): string {
  return u === "us" ? "°F" : "°C";
}

export function windUnit(u: Units): string {
  if (u === "si") return "m/s";
  if (u === "ca") return "km/h";
  return "mph";
}

export function precipIntensityUnit(u: Units): string {
  return u === "us" ? "in/h" : "mm/h";
}

export function accumulationUnit(u: Units): string {
  return u === "us" ? "in" : "cm";
}

export function visibilityUnit(u: Units): string {
  return u === "us" || u === "uk" || u === "uk2" ? "mi" : "km";
}

export function pressureUnit(): string {
  return "hPa";
}

export function formatTemp(v: number | undefined): string {
  return v === undefined || Number.isNaN(v) ? "-" : `${Math.round(v)}°`;
}

export function formatPrecipIntensity(v: number, u: Units): string {
  if (u === "us") {
    return v < 0.1 ? `${(v * 1000).toFixed(0)} mil/h` : `${v.toFixed(2)} in/h`;
  }
  return `${v < 1 ? v.toFixed(2) : v.toFixed(1)} ${precipIntensityUnit(u)}`;
}

export function formatPercent(v: number | undefined): string {
  return v === undefined || Number.isNaN(v) ? "-" : `${Math.round(v * 100)}%`;
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

export function compass(bearing: number | undefined): string {
  if (bearing === undefined || Number.isNaN(bearing)) return "";
  return COMPASS[Math.round(((bearing % 360) + 360) / 22.5) % 16];
}

/** Human readable relative offset, e.g. "in 3h", "2d ago". */
/** Human readable relative offset, e.g. "in 3h", "2d ago". Day mode only
 * kicks in at 48 hours; "in 30h" reads better than "in 1.3d". */
export function relativeDelta(dtMs: number): string {
  const abs = Math.abs(dtMs);
  const past = dtMs < 0;
  let text: string;
  if (abs < 3_600_000) {
    text = `${Math.round(abs / 60_000)}min`;
  } else if (abs < 2 * 86_400_000) {
    const h = abs / 3_600_000;
    text = `${h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h)}h`;
  } else {
    const d = abs / 86_400_000;
    text = `${d < 10 ? d.toFixed(1).replace(/\.0$/, "") : Math.round(d)}d`;
  }
  return past ? `${text} ago` : `in ${text}`;
}
