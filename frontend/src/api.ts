import type { CurrentLocation, GeoResult, Units, WeatherPayload } from "./types";

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) {
    let detail = `${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // Keep the status-derived message.
    }
    throw new Error(detail);
  }
  return (await resp.json()) as T;
}

export function fetchWeather(
  location: CurrentLocation,
  pastDays: number,
  units: Units,
  lang: string,
  signal?: AbortSignal,
): Promise<WeatherPayload> {
  const params = new URLSearchParams({
    lat: location.lat.toFixed(4),
    lon: location.lon.toFixed(4),
    past_days: String(pastDays),
    units,
    lang,
  });
  return fetchJson<WeatherPayload>(`/api/weather?${params}`, signal);
}

export function geocode(query: string, lang: string, signal?: AbortSignal): Promise<GeoResult[]> {
  const params = new URLSearchParams({ q: query, lang });
  return fetchJson<GeoResult[]>(`/api/geocode?${params}`, signal);
}

export function reverseGeocode(
  lat: number,
  lon: number,
  lang: string,
  signal?: AbortSignal,
): Promise<GeoResult> {
  const params = new URLSearchParams({
    lat: lat.toFixed(5),
    lon: lon.toFixed(5),
    lang,
  });
  return fetchJson<GeoResult>(`/api/reverse?${params}`, signal);
}
