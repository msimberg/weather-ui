import { createSignal, For, Show } from "solid-js";

import { setSettings, settings } from "../state";
import type { WarpFn } from "../transform";
import type { Units } from "../types";

const LANGS = ["en", "de", "fr", "it", "es", "nl", "pl", "pt", "zh", "ja"];

const MODELS: { id: string; note: string }[] = [
  { id: "hrrr", note: "HRRR (US, 3 km)" },
  { id: "nbm", note: "NBM (US blend)" },
  { id: "gfs", note: "GFS (US global)" },
  { id: "gefs", note: "GEFS (US ensemble)" },
  { id: "rtma_ru", note: "RTMA (US analysis)" },
  { id: "ecmwf_ifs", note: "ECMWF IFS" },
  { id: "dwd_mosmix", note: "DWD MOSMIX" },
  { id: "raqdps", note: "RAQDPS (air quality)" },
  { id: "silam", note: "SILAM (air quality)" },
];

const WARP_FNS: { id: WarpFn; note: string }[] = [
  { id: "power", note: "power |u|^k: smooth middle ground" },
  { id: "log", note: "log ln(1+ku): strong near-now focus" },
  { id: "asinh", note: "asinh: log-like, gentler at the seam" },
  { id: "atan", note: "atan: saturates hard in the far field" },
  { id: "linear", note: "linear: no warp (reference)" },
];

export function SettingsPanel() {
  const [open, setOpen] = createSignal(false);

  const toggleModel = (id: string, excluded: boolean) => {
    const cur = settings().excludeModels;
    setSettings({
      excludeModels: excluded ? [...cur, id] : cur.filter((m) => m !== id),
    });
  };

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
            Warp function
            <select
              value={settings().warpFn}
              onChange={(e) => setSettings({ warpFn: e.currentTarget.value as WarpFn })}
            >
              <For each={WARP_FNS}>
                {(w) => (
                  <option value={w.id} title={w.note}>
                    {w.id}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label>
            Warp strength
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={settings().warpStrength}
              onInput={(e) => setSettings({ warpStrength: Number(e.currentTarget.value) })}
            />
            <output>{settings().warpStrength.toFixed(2)}</output>
          </label>
          <label>
            Now position
            <input
              type="range"
              min="0.15"
              max="0.7"
              step="0.01"
              value={settings().nowShare}
              onInput={(e) => setSettings({ nowShare: Number(e.currentTarget.value) })}
            />
            <output>{Math.round(settings().nowShare * 100)}%</output>
          </label>
          <label>
            Layout
            <select
              value={settings().layout}
              onChange={(e) => setSettings({ layout: e.currentTarget.value as "full" | "compact" })}
            >
              <option value="full">Full height</option>
              <option value="compact">Compact, centered</option>
            </select>
          </label>
          <label>
            Cloud viz
            <select
              value={settings().cloudViz}
              onChange={(e) => setSettings({ cloudViz: e.currentTarget.value as "density" | "area" })}
            >
              <option value="density">Density shading</option>
              <option value="area">Area + UV line</option>
            </select>
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
          <fieldset class="model-blend">
            <legend>Model blend</legend>
            <label>
              AI models (AIGFS/AIGEFS/AIFS)
              <input
                type="checkbox"
                checked={settings().aiModels}
                onChange={(e) => setSettings({ aiModels: e.currentTarget.checked })}
              />
            </label>
            <div class="model-grid">
              <For each={MODELS}>
                {(m) => (
                  <label title={m.note}>
                    <input
                      type="checkbox"
                      checked={settings().excludeModels.includes(m.id)}
                      onChange={(e) => toggleModel(m.id, e.currentTarget.checked)}
                    />
                    exclude {m.id}
                  </label>
                )}
              </For>
            </div>
          </fieldset>
        </div>
      </Show>
    </div>
  );
}
