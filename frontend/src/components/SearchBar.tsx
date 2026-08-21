import { createSignal, For, Show } from "solid-js";

import { geocode, reverseGeocode } from "../api";
import { location, setLocation, settings } from "../state";
import type { GeoResult } from "../types";

const COORDS_RE = /^\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)\s*$/;

/** Location search backed by Nominatim through our proxy. The input also
 * accepts raw "lat, lon" pairs and a browser-geolocation button. */
export function SearchBar() {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<GeoResult[]>([]);
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(-1);
  const [busy, setBusy] = createSignal(false);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  function runSearch(q: string) {
    const mySeq = ++seq;
    const lang = settings().lang;
    geocode(q, lang)
      .then((rs) => {
        if (mySeq !== seq) return;
        setResults(rs);
        setOpen(rs.length > 0);
        setActive(rs.length > 0 ? 0 : -1);
      })
      .catch(() => {
        if (mySeq !== seq) return;
        setResults([]);
        setOpen(false);
      });
  }

  function onInput(e: InputEvent & { currentTarget: HTMLInputElement }) {
    const q = e.currentTarget.value;
    setQuery(q);
    clearTimeout(debounceTimer);
    const coords = COORDS_RE.exec(q);
    if (coords) {
      setResults([]);
      setOpen(false);
      return;
    }
    if (q.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q.trim()), 280);
  }

  function pick(r: GeoResult) {
    setLocation({ name: r.name, lat: r.lat, lon: r.lon });
    setQuery(r.name);
    setOpen(false);
  }

  function submitCurrent() {
    const q = query();
    const coords = COORDS_RE.exec(q);
    if (coords) {
      pick({ name: q.trim(), lat: Number(coords[1]), lon: Number(coords[2]) });
      return;
    }
    const rs = results();
    if (rs.length > 0) pick(rs[Math.max(0, active())]);
    else if (q.trim().length >= 2) runSearch(q.trim());
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitCurrent();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results().length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function locate() {
    if (!("geolocation" in navigator)) return;
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        reverseGeocode(latitude, longitude, settings().lang)
          .then((r) =>
            setLocation({ name: r.name, lat: r.lat ?? latitude, lon: r.lon ?? longitude }),
          )
          .catch(() =>
            setLocation({
              name: `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`,
              lat: latitude,
              lon: longitude,
            }),
          )
          .finally(() => setBusy(false));
      },
      () => setBusy(false),
      { timeout: 8000, maximumAge: 300_000 },
    );
  }

  return (
    <>
      <div class="search">
        <input
          type="search"
          placeholder="Search place, or enter lat, lon"
          aria-label="Location"
          value={query()}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onFocus={() => results().length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        <Show when={open()}>
          <div class="results" role="listbox">
            <For each={results()}>
              {(r, i) => (
                <button
                  type="button"
                  class={i() === active() ? "active" : ""}
                  role="option"
                  aria-selected={i() === active()}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(r);
                  }}
                >
                  {r.name}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <div class="status-chip" title={location().name}>
        {shortName(location().name)}
      </div>
      <button
        type="button"
        class="icon-btn"
        onClick={locate}
        disabled={busy()}
        title="Use browser location"
        aria-label="Use browser location"
      >
        {busy() ? "..." : "Locate"}
      </button>
    </>
  );
}

function shortName(name: string): string {
  const first = name.split(",")[0].trim();
  return first.length > 24 ? `${first.slice(0, 23)}...` : first;
}
