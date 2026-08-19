import { createEffect, For, Show } from "solid-js";

import { drawIcon, type IconStyle } from "../icons";
import { DARK, LIGHT, iconStyle } from "../render";
import {
  compass,
  formatPercent,
  formatTemp,
  visibilityUnit,
  windUnit,
} from "../format";
import { model, nowTick, resolvedTheme, settings } from "../state";
import { formatClock } from "../time";
import type { HourPoint, Units } from "../types";

const currentIconStyle = (): IconStyle =>
  resolvedTheme() === "light" ? iconStyle(LIGHT) : iconStyle(DARK);

export function IconCanvas(props: { name: string | undefined; size: number }) {
  let ref!: HTMLCanvasElement;
  createEffect(() => {
    const ctx = ref.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ref.width = props.size * dpr;
    ref.height = props.size * dpr;
    ref.style.width = `${props.size}px`;
    ref.style.height = `${props.size}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawIcon(ctx, props.name, 0, 0, props.size, currentIconStyle());
  });
  return <canvas ref={ref} aria-hidden="true" />;
}

/** Big-number strip for the current instant: Dark Sky's dense dashboard row. */
export function CurrentStrip() {
  return (
    <Show when={model()} keyed>
      {(m) => {
        const cur = m.currently;
        const today = m.dayGroups.find((g) => g.label === "Today")?.day;
        return (
          <div class="current">
            <IconCanvas name={cur?.icon} size={44} />
            <span class="big">{formatTemp(cur?.temperature)}</span>
            <span class="summary">
              {cur?.summary ?? ""}
              <Show when={m.summaryMinutely}>
                {(s) => <span class="next-hour">{s()}</span>}
              </Show>
              <Show when={today?.temperatureHigh !== undefined}>
                <span class="next-hour">
                  Today H {formatTemp(today?.temperatureHigh)} / L{" "}
                  {formatTemp(today?.temperatureLow)}
                </span>
              </Show>
            </span>
            <div class="data">
              <For each={chipList(cur, settings().units)}>
                {(c) => (
                  <span class="datum" title={c.title}>
                    <span class="k">{c.label}</span>
                    <span class="v">{c.value}</span>
                  </span>
                )}
              </For>
              <span class="datum" title="Time since the data was fetched">
                <span class="k">as of</span>
                <span class="v">{minutesAgo(nowTick() - m.fetchedAtSec)}</span>
              </span>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

function minutesAgo(sec: number): string {
  if (sec < 75) return "just now";
  return `${Math.round(sec / 60)} min ago`;
}

interface Chip {
  label: string;
  value: string;
  title: string;
}

function chipList(cur: HourPoint | undefined, u: Units): Chip[] {
  const out: Chip[] = [];
  if (!cur) return out;
  const push = (label: string, value: string | number | undefined, title = "") => {
    if (value === undefined || value === null || Number.isNaN(value)) return;
    out.push({ label, value: String(value), title });
  };
  push("feels", formatTemp(cur.apparentTemperature), "Apparent temperature (wind, humidity, solar-corrected)");
  push(
    "wind",
    cur.windSpeed !== undefined
      ? `${cur.windSpeed.toFixed(1)} ${windUnit(u)} ${compass(cur.windBearing)}`
      : undefined,
    "Wind speed and direction",
  );
  push("gusts", cur.windGust !== undefined ? cur.windGust.toFixed(1) : undefined, "Wind gusts");
  push("precip", formatPercent(cur.precipProbability), "Precipitation probability");
  push("humidity", formatPercent(cur.humidity), "Relative humidity");
  push("dew point", formatTemp(cur.dewPoint), "Dew point");
  push("cloud", formatPercent(cur.cloudCover), "Cloud cover");
  push("uv", cur.uvIndex !== undefined ? cur.uvIndex.toFixed(0) : undefined, "UV index");
  push(
    "vis",
    cur.visibility !== undefined
      ? `${cur.visibility.toFixed(1)} ${visibilityUnit(u)}`
      : undefined,
    "Visibility",
  );
  push(
    "pressure",
    cur.pressure !== undefined ? cur.pressure.toFixed(0) : undefined,
    "Sea-level pressure (hPa)",
  );
  push("aqi", cur.airQualityIndex !== undefined ? cur.airQualityIndex.toFixed(0) : undefined, "Air quality index");
  push("cape", cur.cape !== undefined ? cur.cape.toFixed(0) : undefined, "Convective available potential energy (J/kg)");
  push("smoke", cur.smoke !== undefined ? cur.smoke.toFixed(1) : undefined, "Near-surface smoke (ug/m^3)");
  return out;
}

/** Sunrise/sunset for the current day, shown as labeled times. */
export function SunStrip() {
  return (
    <Show when={model()} keyed>
      {(m) => {
        const today = m.dayGroups.find((g) => g.label === "Today")?.day ?? m.dayGroups[0]?.day;
        if (!today?.sunriseTime || !today?.sunsetTime) return null;
        return (
          <div class="sun-strip">
            <span class="k">sunrise</span>
            <span class="v">{formatClock(m.timezone, today.sunriseTime)}</span>
            <span class="k">sunset</span>
            <span class="v">{formatClock(m.timezone, today.sunsetTime)}</span>
          </div>
        );
      }}
    </Show>
  );
}
