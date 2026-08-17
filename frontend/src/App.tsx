import { Show } from "solid-js";

import { Alerts } from "./components/Alerts";
import { CurrentStrip } from "./components/CurrentStrip";
import { SearchBar } from "./components/SearchBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { Timeline } from "./components/Timeline";
import { errorMsg, location, model, stale, status } from "./state";

export function App() {
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
                data: pirateweather.net (model output, past days from archives rather than station observations)
              </span>
            </>
          )}
        </Show>
      </footer>
    </>
  );
}
