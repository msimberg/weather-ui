import { For, Show } from "solid-js";
import { model } from "../state";
import { formatFull } from "../time";

export function Alerts() {
  const alerts = () => model()?.alerts ?? [];
  return (
    <Show when={alerts().length > 0}>
      <div class="alerts" role="alert">
        <For each={alerts()}>
          {(a) => (
            <div class="alert">
              <strong>{a.title}</strong>
              <span>{a.severity ?? ""}</span>
              <Show when={model()} keyed>
                {(m) => <time>until {formatFull(m.timezone, a.expires)}</time>}
              </Show>
              {a.uri ? (
                <a href={a.uri} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                  details
                </a>
              ) : null}
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
