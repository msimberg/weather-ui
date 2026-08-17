import { createSignal, Show } from "solid-js";

import { setSettings, settings } from "../state";
import { MIN_POWER } from "../transform";
import type { Units } from "../types";

const LANGS = ["en", "de", "fr", "it", "es", "nl", "pl", "pt", "zh", "ja"];

export function SettingsPanel() {
  const [open, setOpen] = createSignal(false);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        class="icon-btn"
        onClick={() => setOpen(!open())}
        aria-label="Settings"
        title="Settings"
      >
        {open() ? "Close" : "Settings"}
      </button>
      <Show when={open()}>
        <div class="settings-panel">
          <label>
            Past days
            <input
              type="range"
              min="0"
              max="14"
              step="1"
              value={settings().pastDays}
              onInput={(e) => setSettings({ pastDays: Number(e.currentTarget.value) })}
            />
            <output>{settings().pastDays}</output>
          </label>
          <label>
            Future days
            <input
              type="range"
              min="1"
              max="7"
              step="1"
              value={settings().futureDays}
              onInput={(e) => setSettings({ futureDays: Number(e.currentTarget.value) })}
            />
            <output>{settings().futureDays}</output>
          </label>
          <label>
            Near-now detail
            <input
              type="range"
              min={MIN_POWER}
              max="1"
              step="0.01"
              value={settings().power}
              onInput={(e) => setSettings({ power: Number(e.currentTarget.value) })}
            />
            <output>{settings().power.toFixed(2)}</output>
          </label>
          <label>
            Units
            <select
              value={settings().units}
              onChange={(e) => setSettings({ units: e.currentTarget.value as Units })}
            >
              <option value="si">SI (C, m/s)</option>
              <option value="ca">CA (C, km/h)</option>
              <option value="uk">UK (C, mph)</option>
              <option value="uk2">UK2 (C, mph, vis mi)</option>
              <option value="us">US (F, mph)</option>
            </select>
          </label>
          <label>
            Theme
            <select
              value={settings().theme}
              onChange={(e) => setSettings({ theme: e.currentTarget.value as "auto" | "light" | "dark" })}
            >
              <option value="auto">Auto</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label>
            Summary language
            <select
              value={settings().lang}
              onChange={(e) => setSettings({ lang: e.currentTarget.value })}
            >
              {LANGS.map((l) => (
                <option value={l}>{l}</option>
              ))}
            </select>
          </label>
        </div>
      </Show>
    </div>
  );
}
