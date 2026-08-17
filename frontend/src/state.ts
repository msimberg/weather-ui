import { createEffect, createSignal } from "solid-js";

import { fetchWeather } from "./api";
import { prepare, type Prepared } from "./prepare";
import type { CurrentLocation, Units, WeatherPayload } from "./types";

export interface Settings {
  units: Units;
  theme: "auto" | "light" | "dark";
  /** How many days of history the axis shows; each costs one upstream call on a cold cache. */
  pastDays: number;
  /** Display clamp on the future limb; the API always returns 7 days. */
  futureDays: number;
  /** Warp exponent: 1 is linear, smaller expands the near term more. */
  power: number;
  lang: string;
}

const DEFAULT_SETTINGS: Settings = {
  units: "si",
  theme: "auto",
  pastDays: 4,
  futureDays: 7,
  power: 0.4,
  lang: "en",
};

// Sensible first-visit default for a CSCS workstation; any use of the
// location search persists over it.
const DEFAULT_LOCATION: CurrentLocation = {
  name: "Zurich, Switzerland",
  lat: 47.3769,
  lon: 8.5417,
};

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: persistence is best effort.
  }
}

export const [settings, setSettingsRaw] = createSignal<Settings>({
  ...DEFAULT_SETTINGS,
  ...(readJson<Partial<Settings>>("wu.settings") ?? {}),
});
export const [location, setLocationRaw] = createSignal<CurrentLocation>(
  readJson<CurrentLocation>("wu.location") ?? DEFAULT_LOCATION,
);

export type Status = "idle" | "loading" | "ready" | "error";

export const [model, setModel] = createSignal<Prepared | null>(null);
export const [status, setStatus] = createSignal<Status>("idle");
export const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
/** True while freshly fetched data is pending but cached data is on screen. */
export const [stale, setStale] = createSignal(false);
export const [hoverSec, setHoverSec] = createSignal<number | null>(null);
/** Ticks every 30s so "now" and the axis drift with wall time. */
export const [nowTick, setNowTick] = createSignal(Math.floor(Date.now() / 1000));

export function setSettings(patch: Partial<Settings>): void {
  setSettingsRaw((s) => ({ ...s, ...patch }));
}

export function setLocation(loc: CurrentLocation): void {
  setLocationRaw(loc);
}

createEffect(() => writeJson("wu.settings", settings()));
createEffect(() => writeJson("wu.location", location()));

createEffect(() => {
  const theme = settings().theme;
  const apply = () => {
    const resolved =
      theme === "auto"
        ? matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : theme;
    document.documentElement.dataset.theme = resolved;
  };
  apply();
  if (theme === "auto") {
    const mq = matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }
});

export function resolvedTheme(): "light" | "dark" {
  const t = settings().theme;
  if (t !== "auto") return t;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

let fetchSeq = 0;
let aborter: AbortController | null = null;
let lastFetchMs = 0;

const CACHE_PREFIX = "wu.cache.";

function cacheKey(loc: CurrentLocation, s: Settings): string {
  return `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}:${s.pastDays}:${s.units}:${s.lang}`;
}

function loadCached(key: string): WeatherPayload | null {
  const entry = readJson<{ payload: WeatherPayload }>(CACHE_PREFIX + key);
  return entry?.payload ?? null;
}

function storeCached(key: string, payload: WeatherPayload): void {
  // Keep at most a handful of cached views: payloads are 100+ KB and
  // localStorage quotas are small.
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length >= 8) {
      keys.sort().slice(0, keys.length - 7).forEach((k) => localStorage.removeItem(k));
    }
  } catch {
    // Best effort pruning.
  }
  writeJson(CACHE_PREFIX + key, { savedAt: Date.now(), payload });
}

export async function refreshWeather(): Promise<void> {
  const loc = location();
  const s = settings();
  const key = cacheKey(loc, s);

  const cached = loadCached(key);
  if (cached && model() === null) {
    setModel(prepare(cached, Math.floor(Date.now() / 1000)));
    setStale(true);
  }
  setStatus("loading");
  aborter?.abort();
  const ac = new AbortController();
  aborter = ac;
  const seq = ++fetchSeq;
  try {
    const payload = await fetchWeather(loc, s.pastDays, s.units, s.lang, ac.signal);
    if (seq !== fetchSeq) return; // superseded by a newer request
    storeCached(key, payload);
    lastFetchMs = Date.now();
    setModel(prepare(payload, Math.floor(Date.now() / 1000)));
    setStatus("ready");
    setStale(false);
    setErrorMsg(null);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    if (seq !== fetchSeq) return;
    setStatus("error");
    setErrorMsg(e instanceof Error ? e.message : String(e));
  }
}

// Refetch inputs: location, range, and language. Zoom/theme/warp changes are
// local and never hit the network.
createEffect(() => {
  const s = settings();
  const loc = location();
  const key = cacheKey(loc, s);
  void key;
  const timer = setTimeout(() => void refreshWeather(), 250);
  return () => clearTimeout(timer);
});

setInterval(() => setNowTick(Math.floor(Date.now() / 1000)), 30_000);

// Silent refresh after 9.5 idle minutes, only while visible.
setInterval(() => {
  if (document.hidden) return;
  if (model() && Date.now() - lastFetchMs > 9.5 * 60_000) void refreshWeather();
}, 60_000);
