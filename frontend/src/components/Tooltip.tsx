import { For, Show } from "solid-js";

import {
  accumulationUnit,
  compass,
  formatPercent,
  formatPrecipIntensity,
  formatTemp,
  relativeDelta,
  visibilityUnit,
  windUnit,
} from "../format";
import { sampleAt, type Prepared, type Sample } from "../prepare";
import { formatClock, formatFull } from "../time";
import { settings, nowTick } from "../state";
import type { DayPoint, HourPoint } from "../types";

interface Row {
  label: string;
  value: string;
}

/** The crosshair readout: one card per pointer position, listing everything
 * the API reports for the nearest sample. The sample tier (minute, hour, or
 * day aggregate) is shown so precision never masquerades as detail. */
export function Tooltip(props: {
  model: Prepared;
  tSec: number;
  style: { x: number; y: number };
}) {
  const sample = () => sampleAt(props.model, props.tSec);
  const rows = () => buildRows(sample(), props.model, settings().units);

  return (
    <div class="tooltip" style={{ left: `${props.style.x}px`, top: `${props.style.y}px` }}>
      <Show when={sample()} keyed>
        {(s: Sample) => (
          <>
            <div class="t-head">
              <span>{formatFull(props.model.timezone, props.tSec)}</span>
              <span class="delta">{relativeDelta((props.tSec - nowTick()) * 1000)}</span>
            </div>
            <div class="t-kind">{kindLabel(s)}</div>
            <table>
              <tbody>
                <For each={rows()}>
                  {(r) => (
                    <tr>
                      <td>{r.label}</td>
                      <td>{r.value}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <Show when={s.minute && s.minute.precipIntensity !== undefined}>
              <table>
                <tbody>
                  <tr>
                    <td>minute {formatClock(props.model.timezone, s.minute!.time)}</td>
                    <td>
                      {formatPrecipIntensity(s.minute!.precipIntensity ?? 0, settings().units)}
                      {s.minute!.precipProbability !== undefined &&
                        ` @ ${formatPercent(s.minute!.precipProbability)}`}
                    </td>
                  </tr>
                </tbody>
              </table>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function layerSummary(model: Prepared, tSec: number | undefined): string | undefined {
  const layers = model.cloudLayers;
  if (!layers || tSec === undefined) return undefined;
  let best = -1;
  for (let i = 0; i < layers.time.length; i++) {
    if (best < 0 || Math.abs(layers.time[i] - tSec) < Math.abs(layers.time[best] - tSec)) best = i;
  }
  if (best < 0) return undefined;
  const fmt = (a: number[] | undefined) => (a && a[best] !== undefined ? String(Math.round(a[best])) : "-");
  return `${fmt(layers.low)} / ${fmt(layers.mid)} / ${fmt(layers.high)} %`;
}

function kindLabel(s: Sample): string {
  switch (s.kind) {
    case "minute":
      return "per-minute nowcast + hourly";
    case "hour":
      return "hourly";
    case "day":
      return "daily aggregate";
  }
}

function buildRows(s: Sample | null, model: Prepared, u: ReturnType<typeof settings>["units"]): Row[] {
  const tz = model.timezone;
  if (!s) return [];
  const rows: Row[] = [];
  const push = (label: string, value: string | number | undefined) => {
    if (value === undefined || value === null) return;
    if (typeof value === "number" && Number.isNaN(value)) return;
    rows.push({ label, value: String(value) });
  };
  const p: HourPoint | undefined = s.hour;
  if (p) {
    push("summary", p.summary);
    push("temp", formatTemp(p.temperature));
    push("feels like", formatTemp(p.apparentTemperature));
    push("dew point", formatTemp(p.dewPoint));
    push("humidity", formatPercent(p.humidity));
    push(
      "precip",
      p.precipIntensity !== undefined
        ? `${formatPrecipIntensity(p.precipIntensity, u)} @ ${formatPercent(p.precipProbability)}${p.precipType ? " " + p.precipType : ""}`
        : formatPercent(p.precipProbability),
    );
    push(
      "accum rain/snow/ice",
      p.liquidAccumulation !== undefined ||
        p.snowAccumulation !== undefined ||
        p.iceAccumulation !== undefined
        ? `${(p.liquidAccumulation ?? 0).toFixed(2)} / ${(p.snowAccumulation ?? 0).toFixed(2)} / ${(p.iceAccumulation ?? 0).toFixed(2)} ${accumulationUnit(u)}`
        : undefined,
    );
    push(
      "wind",
      p.windSpeed !== undefined
        ? `${p.windSpeed.toFixed(1)} ${windUnit(u)} ${compass(p.windBearing)}`
        : undefined,
    );
    push(
      "gusts",
      p.windGust !== undefined ? `${p.windGust.toFixed(1)} ${windUnit(u)}` : undefined,
    );
    push("pressure", p.pressure !== undefined ? `${p.pressure.toFixed(1)} hPa` : undefined);
    push("cloud", formatPercent(p.cloudCover));
    push("cloud low/mid/high", layerSummary(model, s.hour?.time));
    push("uv", p.uvIndex !== undefined ? p.uvIndex.toFixed(1) : undefined);
    push(
      "visibility",
      p.visibility !== undefined ? `${p.visibility.toFixed(1)} ${visibilityUnit(u)}` : undefined,
    );
    push("ozone", p.ozone !== undefined ? `${p.ozone.toFixed(0)} DU` : undefined);
    push("cape", p.cape !== undefined ? `${p.cape.toFixed(0)} J/kg` : undefined);
    push("smoke", p.smoke !== undefined ? `${p.smoke.toFixed(1)} ug/m^3` : undefined);
    push("fire index", p.fireIndex?.toFixed(0));
    push("aqi", p.airQualityIndex?.toFixed(0));
    push("solar", p.solar !== undefined ? `${p.solar.toFixed(0)} W/m^2` : undefined);
    push(
      "storm dist/brg",
      p.nearestStormDistance !== undefined
        ? `${p.nearestStormDistance.toFixed(0)} ${visibilityUnit(u)} ${compass(p.nearestStormBearing)}`
        : undefined,
    );
  }
  const d: DayPoint | undefined = s.kind === "day" ? s.day : undefined;
  if (d) {
    push("H / L", `${formatTemp(d.temperatureHigh)} / ${formatTemp(d.temperatureLow)}`);
    push(
      "feels H / L",
      `${formatTemp(d.apparentTemperatureHigh)} / ${formatTemp(d.apparentTemperatureLow)}`,
    );
    push(
      "H at",
      d.temperatureHighTime !== undefined ? formatClock(tz, d.temperatureHighTime) : undefined,
    );
    push("sunrise", d.sunriseTime !== undefined ? formatClock(tz, d.sunriseTime) : undefined);
    push("sunset", d.sunsetTime !== undefined ? formatClock(tz, d.sunsetTime) : undefined);
    push("moon", d.moonPhase !== undefined ? moonName(d.moonPhase) : undefined);
    push(
      "precip accum",
      d.precipAccumulation !== undefined
        ? `${d.precipAccumulation.toFixed(1)} ${accumulationUnit(u)}`
        : undefined,
    );
    push(
      "max intensity",
      d.precipIntensityMax !== undefined
        ? formatPrecipIntensity(d.precipIntensityMax, u)
        : undefined,
    );
  }
  return rows;
}

function moonName(phase: number): string {
  const names = [
    "new",
    "waxing crescent",
    "first quarter",
    "waxing gibbous",
    "full",
    "waning gibbous",
    "last quarter",
    "waning crescent",
  ];
  return `${names[Math.round(phase * 8) % 8]} (${phase.toFixed(2)})`;
}
