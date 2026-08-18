import { createEffect, createSignal } from "solid-js";

import { fetchWeather } from "./api";
import { prepare, type Prepared } from "./prepare";
import { DEFAULT_NOW_SHARE, DEFAULT_WARP, clamp01, type WarpFn } from "./transform";
import type { CurrentLocation, Units, WeatherPayload } from "./types";

export interface Settings {
  units: Units;
  theme: "auto" | "light" | "dark";
  /** How many days of history the axis shows; each costs one upstream call on a cold cache. */
  pastDays: number;
  /** Display clamp on the future limb; the API always returns 7 days. */
  futureDays: number;
  /** Warp curve family for the fisheye axis. */
  warpFn: WarpFn;
  /** 0 = linear in every family, 1 = strongest near-now magnification. */
  warpStrength: number;
  /** Fraction of the axis width left of the "now" anchor. */
  nowShare: number;
  /** Cloud band style: density columns vs area + UV line. */
  cloudViz: "density" | "area";
  /** full = bands fill the viewport height; compact = shorter, centered. */
  layout: "full" | "compact";
  /** Pirate Weather model families removed from the blend. */
  excludeModels: string[];
  /** Pirate Weather include=aimodels (AIGFS/AIGEFS/ECMWF-AIFS join the blend). */
  aiModels: boolean;
  lang: string;
}

const DEFAULT_SETTINGS: Settings = {
  units: "si",
  theme: "auto",
  pastDays: 4,
  futureDays: 7,
  warpFn: DEFAULT_WARP.fn,
  warpStrength: DEFAULT_WARP.strength,
  nowShare: DEFAULT_NOW_SHARE,
  cloudViz: "density",
  layout: "full",
  excludeModels: [],
  aiModels: false,
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

/** Pre-warp-family settings used {power: 0.15..1}; map it onto strength. */
function migrateSettings(stored: Partial<Settings> & { power?: number }): Settings {
  const { power, ...rest } = stored;
  const out: Settings = { ...DEFAULT_SETTINGS, ...rest };
  if (typeof power === "number" && stored.warpStrength === undefined) {
    out.warpFn = "power";
    out.warpStrength = clamp01((1 - power) / 0.85);
  }
  return out;
}

export const [settings, setSettingsRaw] = createSignal<Settings>(
  migrateSettings(readJson("wu.settings") ?? {}),
);
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
/** Zen mode: hides header/strip/footer so only the timeline remains. */
export const [zen, setZen] = createSignal(false);

export function setSettings(patch: Partial<Settings>): void {
  setSettingsRaw((s) => ({ ...s, ...patch }));
}

export function setLocation(loc: CurrentLocation): void {
  setLocationRaw(loc);
}

createEffect(() => writeJson("wu.settings", settings()));
createEffect(() => writeJson("wu.location", location()));

// The media query is lifted into a signal so canvas palettes (which are
// computed reactively) also repaint when the OS theme flips in auto mode.
const mediaLightQuery = matchMedia("(prefers-color-scheme: light)");
const [mediaLight, setMediaLight] = createSignal(mediaLightQuery.matches);
mediaLightQuery.addEventListener("change", (e) => setMediaLight(e.matches));

export function resolvedTheme(): "light" | "dark" {
  const t = settings().theme;
  if (t !== "auto") return t;
  return mediaLight() ? "light" : "dark";
}

createEffect(() => {
  document.documentElement.dataset.theme = resolvedTheme();
});

let fetchSeq = 0;
let aborter: AbortController | null = null;
let lastFetchMs = 0;

const CACHE_PREFIX = "wu.cache.";

function cacheKey(loc: CurrentLocation, s: Settings): string {
  const models = `${s.excludeModels.slice().sort().join("-")}+${s.aiModels ? 1 : 0}`;
  return `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}:${s.pastDays}:${s.units}:${s.lang}:${models}`;
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

// Paint the last cached view synchronously at startup so a returning visit
// never shows an empty timeline; the network refresh swaps in when it lands.
function preloadFromCache(): void {
  const payload = loadCached(cacheKey(location(), settings()));
  if (!payload) return;
  try {
    setModel(prepare(payload, Math.floor(Date.now() / 1000)));
    setStale(true);
  } catch (e) {
    console.error("cached payload failed to prepare; ignoring it", e);
  }
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
    const payload = await fetchWeather(
      loc,
      s.pastDays,
      s.units,
      s.lang,
      s.excludeModels,
      s.aiModels,
      ac.signal,
    );
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

// Refetch inputs: location, range, language, and the model blend. Zoom,
// theme, warp, and layout changes are local and never hit the network.
createEffect(() => {
  const s = settings();
  const loc = location();
  void cacheKey(loc, s);
  const timer = setTimeout(() => void refreshWeather(), 250);
  return () => clearTimeout(timer);
});

setInterval(() => setNowTick(Math.floor(Date.now() / 1000)), 30_000);

// Silent refresh after 9.5 idle minutes, only while visible.
setInterval(() => {
  if (document.hidden) return;
  if (model() && Date.now() - lastFetchMs > 9.5 * 60_000) void refreshWeather();
}, 60_000);

preloadFromCache();
