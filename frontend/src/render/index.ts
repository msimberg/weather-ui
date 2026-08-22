// Canvas renderer entry point. One pass per frame:
//   night shading -> midnight dividers -> four data bands (ordered by
//   settings) -> past-fade overlay -> hour gridlines (current day) ->
//   axis (day labels, hour labels, ticks) -> now marker -> crosshair.
//
// Detail is driven by time distance from "now": near now the hourly lines
// are at full strength, and they fade with |t - now| toward daily
// aggregates in the far field. The handoff never shifts with window width.

import type { Prepared } from "../prepare";
import { MIN_PAST_ALPHA, pastFade, type TimeAxis } from "../transform";
import type { Units } from "../types";
import { drawAxis, drawCrosshair, drawCurrentDayHours, drawNow, hourLabelTimes } from "./axis";
import { type BandEnv, drawCloud, drawPrecip, drawTemp, drawWind } from "./bands";
import {
  type BandRect,
  bandLayout,
  canvasRight,
  type Layout,
  leftGutter,
  RIGHT_PAD,
  TITLE_W,
} from "./layout";
import { type Ctx, makeGreedyLabels } from "./paint";
import type { Palette } from "./palette";

export interface ViewOptions {
  nowSec: number;
  axis: TimeAxis;
  units: Units;
  palette: Palette;
  hoverSec: number | null;
  bandOrder: string[];
  bandRatios: Record<string, number>;
}

export const BAND_ORDER: string[] = ["cloud", "temp", "precip", "wind"];
export const BAND_TITLE: Record<string, string> = {
  precip: "PRECIP",
  cloud: "CLOUD",
  wind: "WIND",
  temp: "TEMP",
};

export const BAND_EXPLAIN: Record<string, string> = {
  precip:
    "Bars = hourly intensity (sqrt scale, by type). Line = probability. Halo = upstream intensity error. Per-day total shown where space allows.",
  cloud:
    "Blended cloud cover at low / mid / high altitude (darker = more cover). Step line = UV index, scaled to the day's peak.",
  wind: "Line = speed. Thin line = gusts. Barbs point where the wind comes from; feathers mark 5 / 10 / 50 knots.",
  temp: "Line = hourly temperature (fades far from now). Dashed = feels-like. Dots = daily high and low with the value reached.",
};

export function renderTimeline(
  canvas: HTMLCanvasElement,
  model: Prepared,
  view: ViewOptions,
): void {
  const { axis, palette, hoverSec } = view;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const L = bandLayout(cssW, cssH, view.bandOrder, view.bandRatios);
  const X = (tSec: number): number => L.gutter + axis.t2x(tSec * 1000);
  const tAtX = (x: number): number => axis.x2t(x - L.gutter) / 1000;
  const Xnow = L.gutter + axis.cx;
  const fade = (tSec: number): number => pastFade(tSec * 1000, axis.now, axis.pastMs);

  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, cssW, cssH);
  drawNights(ctx, model, X, L, palette);
  drawDividers(ctx, palette, model, X, L);

  const env: BandEnv = { palette, units: view.units, nowSec: view.nowSec };
  const labels = makeGreedyLabels();
  for (const name of view.bandOrder) {
    const band = L.bands[name];
    if (!band) continue;
    if (name === "precip") drawPrecip(ctx, model, env, band, X, fade, labels, L.gutter, L.right);
    else if (name === "temp") drawTemp(ctx, model, env, band, X, fade, labels, L.gutter, L.right);
    else if (name === "wind") drawWind(ctx, model, env, band, X, fade, labels, L.gutter, L.right);
    else if (name === "cloud") drawCloud(ctx, model, env, band, X, tAtX, fade, labels);
  }

  fadePast(ctx, L, Xnow);

  // Hour labels and the current-day gridlines come from the same labeled
  // set, so the grid always sits exactly under the printed ticks.
  const labeled = new Set(
    hourLabelTimes(
      model.timezone,
      model.dayGroups,
      model.hours.map((h) => h.time),
      view.nowSec,
      X,
      L.gutter,
      L.right,
    ),
  );
  drawCurrentDayHours(ctx, palette, model, L, X, view.nowSec, labeled);
  drawAxis(ctx, palette, model, L, X, labeled, cssH);
  drawNow(ctx, palette, Xnow, L.bandsTop, L.bandsBottom);
  if (hoverSec !== null) drawCrosshair(ctx, model, palette, hoverSec, X, L.bands);
}

/** Night shading: merged spans under everything else, full band height. */
function drawNights(
  ctx: Ctx,
  model: Prepared,
  X: (t: number) => number,
  L: Layout,
  palette: Palette,
) {
  ctx.fillStyle = palette.night;
  for (const span of model.nights) {
    const x0 = Math.max(L.gutter, X(span.startSec));
    const x1 = Math.min(L.right, X(span.endSec));
    if (x1 > x0) ctx.fillRect(x0, L.bandsTop, x1 - x0, L.bandsBottom - L.bandsTop);
  }
}

/** Dashed midnight dividers spanning the bands. */
function drawDividers(
  ctx: Ctx,
  palette: Palette,
  model: Prepared,
  X: (t: number) => number,
  L: Layout,
) {
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = palette.lineScale;
  ctx.setLineDash([5, 4]);
  for (const g of model.dayGroups) {
    const x = X(g.startSec);
    if (x > L.gutter + 2 && x < L.right - 1) {
      ctx.beginPath();
      ctx.moveTo(x, L.bandsTop);
      ctx.lineTo(x, L.bandsBottom);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

/** Fade everything data-ward of now, linearly toward MIN_PAST_ALPHA at the
 * left edge. destination-out erases opacity, leaving chrome untouched. */
function fadePast(ctx: Ctx, L: Layout, Xnow: number) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  const grad = ctx.createLinearGradient(L.gutter, 0, Xnow, 0);
  const eraseMax = 1 - MIN_PAST_ALPHA;
  const STOPS = 8;
  for (let i = 0; i <= STOPS; i++) {
    grad.addColorStop(i / STOPS, `rgba(0, 0, 0, ${eraseMax * (1 - i / STOPS)})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(L.gutter, L.bandsTop, Xnow - L.gutter, L.bandsBottom - L.bandsTop);
  ctx.restore();
}

// For unit tests: step selection and day-label fit live in ./axis.
export { dayLabelsRotate, HOUR_STEPS, hourLabelTimes } from "./axis";
export type { Palette } from "./palette";
export { DARK, DARK_HC, iconStyle, LIGHT, LIGHT_HC, UI_FONT } from "./palette";
export type { BandRect, Layout };
// Re-exports so callers (state, components) have one import surface.
export { bandLayout, canvasRight, leftGutter, RIGHT_PAD, TITLE_W };
