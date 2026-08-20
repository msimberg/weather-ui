import { createEffect, onCleanup, onMount, Show } from "solid-js";

import { Alerts } from "./components/Alerts";
import { CurrentStrip, SunStrip } from "./components/CurrentStrip";
import { SearchBar } from "./components/SearchBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { Timeline } from "./components/Timeline";
import { errorMsg, focus, location, model, setFocus, stale, settings, status } from "./state";

export function App() {
  createEffect(() => {
    document.getElementById("root")?.classList.toggle("focus", focus());
    document.getElementById("root")?.classList.toggle("compact", settings().layout === "compact");
  });
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      setFocus(!focus());
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  return (
    <>
      <header>
        <SearchBar />
        <span classList={{ "status-chip": true, error: status() === "error" }}>
          <Show when={status() === "error"} fallback={stale() ? "refreshing..." : status() === "loading" && !model() ? "loading..." : ""}>
            {errorMsg()}
          </Show>
        </span>
        <SettingsPanel />
      </header>
      <Alerts />
      <CurrentStrip />
      <SunStrip />
      <Timeline />
      <footer>
        <Show when={model()} keyed>
          {(m) => (
            <>
              <span>
                {location().name} ({m.timezone.replace("_", " ")}
                {m.elevation !== undefined ? `, ${m.elevation} m` : ""})
              </span>
              <span>
                sources: {m.sources.join(", ") || "unknown"}
                {m.apiVersion ? `, api ${m.apiVersion}` : ""}
              </span>
              <Show when={m.warnings.length > 0}>
                <span class="warn">
                  {m.warnings.length} past-day load failure(s); some history may be missing
                </span>
              </Show>
              <span>
                {settings().provider === "pirateweather"
                  ? "data: pirateweather.net (model output, past days from archives rather than station observations)"
                  : settings().provider === "meteoblue"
                    ? "data: meteoblue.com (forecast) + open-meteo.com (fill)"
                    : "data: open-meteo.com (CC BY 4.0; best-match national models, ICON-CH 1-2 km in Switzerland)"}
              </span>
            </>
          )}
        </Show>
      </footer>
    </>
  );
}
