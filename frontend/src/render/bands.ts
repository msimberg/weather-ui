// The four data-band painters: precipitation, temperature, wind, cloud/UV.
// Each is called once per frame with its band rect and the shared helpers.

import { formatTemp, windUnit } from "../format";
import type { Prepared } from "../prepare";
import { clamp01 } from "../transform";
import type { HourPoint, Units } from "../types";
import { BAND_PAD, type BandRect } from "./layout";
import {
  bandY,
  type Ctx,
  clampX,
  type GreedyLabels,
  interpSeries,
  labelHalo,
  lineFade,
  type Pt,
  strokeWeighted,
  traceSmooth,
} from "./paint";
import { type Palette, uiFont } from "./palette";

/** What a band painter is allowed to know about the view. */
export interface BandEnv {
  palette: Palette;
  units: Units;
  nowSec: number;
}

const dataFont = (p: Palette) => uiFont(p.boldText ? 600 : 400, 10);
const dataBoldFont = (p: Palette) => uiFont(p.boldText ? 800 : 600, 10);

// Day-aggregate labels keep a +0.15 alpha floor so the far field stays
// readable where the hourly detail has faded out.
const AGGREGATE_MIN_ALPHA = 0.15;

// --- precip -----------------------------------------------------------------

function precipColor(kind: string | undefined, palette: Palette): string {
  switch (kind) {
    case "snow":
      return palette.snow;
    case "sleet":
    case "ice":
    case "hail":
      return palette.ice;
    default:
      return palette.rain;
  }
}

function slotWidth(xs: number[], i: number, cap: number): number {
  const here = xs[i];
  const prev = i > 0 ? xs[i - 1] : here * 2 - (xs[i + 1] ?? here);
  const next = i < xs.length - 1 ? xs[i + 1] : 2 * here - prev;
  const slot = Math.min(here - prev, next - here);
  return Math.max(1.2, Math.min(cap, slot * 0.98));
}

export function drawPrecip(
  ctx: Ctx,
  model: Prepared,
  env: BandEnv,
  band: BandRect,
  X: (t: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
  gutter: number,
  right: number,
) {
  const { palette } = env;
  const depth = band.y1 - band.y0 - 2 * BAND_PAD;
  const base = band.y1 - BAND_PAD;
  const pxMax = model.domains.precipMax;
  const h = (v: number): number => Math.max(1, Math.sqrt(Math.min(1, v / pxMax)) * depth);

  const probPts: Pt[] = [];
  for (const hr of model.hours) {
    if (hr.precipProbability === undefined) continue;
    probPts.push({
      x: X(hr.time),
      y: band.y0 + BAND_PAD + (1 - Math.min(1, Math.max(0, hr.precipProbability))) * depth,
      w: 0.75 * fade(hr.time),
    });
  }

  // Contiguous bars: each spans to the midpoint with its neighbours, at
  // whole-pixel edges. Both bars compute the same midpoint value and round
  // it to the same integer column boundary, so bar i's right edge IS bar
  // i+1's left edge; fillRect at integer coordinates covers full pixel
  // columns and there is no half-covered seam column between them.
  const xs = model.hours.map((hr) => X(hr.time));
  const barX = (i: number): [number, number] => {
    const here = xs[i];
    const prev = i > 0 ? xs[i - 1] : 2 * here - xs[i + 1];
    const next = i < xs.length - 1 ? xs[i + 1] : 2 * here - prev;
    const x0 = Math.round(Math.max(gutter, (prev + here) / 2));
    const x1 = Math.round(Math.min(right, (here + next) / 2));
    return [x0, Math.max(x0, x1)];
  };
  for (let i = 0; i < model.hours.length; i++) {
    const hr = model.hours[i];
    const v = hr.precipIntensity ?? 0;
    const err = hr.precipIntensityError ?? 0;
    const w = fade(hr.time);
    const [x0, x1] = barX(i);
    const bw = x1 - x0;
    if (bw < 1) continue; // compressed below one pixel column: nothing to paint
    if (err > 0.02 && v + err > 0.01) {
      const lo = Math.max(0, v - err);
      ctx.globalAlpha = 0.18 * w;
      ctx.fillStyle = precipColor(hr.precipType, palette);
      ctx.fillRect(x0, base - h(v + err), bw, Math.max(1, h(v + err) - h(lo)));
    }
    if (v > 0.01) {
      ctx.globalAlpha = 0.92 * w;
      ctx.fillStyle = precipColor(hr.precipType, palette);
      ctx.fillRect(x0, base - h(v), bw, h(v));
    }
  }

  if (model.minutes.length > 1) {
    const mx = model.minutes.map((m) => X(m.time));
    for (let i = 0; i < model.minutes.length; i++) {
      const m = model.minutes[i];
      const v = m.precipIntensity ?? 0;
      if (v <= 0.01) continue;
      const bw = slotWidth(mx, i, 8);
      if (bw < 1.6) break;
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = precipColor(m.precipType, palette);
      ctx.fillRect(mx[i] - bw / 2, base - h(v), bw, h(v));
    }
  }

  strokeWeighted(ctx, probPts, palette.sub, 1.4 * palette.lineScale);

  labels.reset();
  ctx.font = dataFont(palette);
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const g of model.dayGroups) {
    const accum = g.day.precipAccumulation;
    if (accum === undefined || accum <= 0.2) continue;
    const x0 = Math.max(gutter, X(g.startSec));
    const x1 = Math.min(right, X(g.endSec));
    if (x1 - x0 < 36) continue;
    const cx = (x0 + x1) / 2;
    if (!labels.tryPlace(cx, 20)) continue;
    const mid = (g.startSec + g.endSec) / 2;
    ctx.globalAlpha = Math.min(1, fade(mid) + AGGREGATE_MIN_ALPHA);
    const text =
      env.units === "us"
        ? `${accum.toFixed(2)}in`
        : `${(accum * 10).toFixed(accum * 10 < 10 ? 1 : 0)}mm total`;
    // The label sits just above the bar baseline (visually near the foot
    // of the band but with a hair of air under it), over the rain bars, so
    // it gets a bg-colored stroke outline to stay legible there.
    labelHalo(ctx, text, cx, band.y1 - BAND_PAD - 1, palette.bg, 90);
    ctx.fillStyle = palette.sub;
    ctx.fillText(text, cx, band.y1 - BAND_PAD - 1, 90);
  }
  ctx.globalAlpha = 1;
}

// --- temperature ------------------------------------------------------------

function tempRefs(units: Units): number[] {
  return units === "us" ? [32, 68] : [0, 20];
}

export function drawTemp(
  ctx: Ctx,
  model: Prepared,
  env: BandEnv,
  band: BandRect,
  X: (t: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
  gutter: number,
  right: number,
) {
  const { palette } = env;
  const { tempLo, tempHi } = model.domains;
  const depth = band.y1 - band.y0 - 2 * BAND_PAD;
  const y = (v: number): number => band.y1 - BAND_PAD - ((v - tempLo) / (tempHi - tempLo)) * depth;

  // A faint, smooth envelope through daily extremes anchors the far field;
  // the hourly line reads on top of it. There is no min/max outline.
  const days: { mid: number; hi: number; lo: number }[] = [];
  for (const g of model.dayGroups) {
    const hi = g.day.temperatureHigh ?? g.day.temperatureMax;
    const lo = g.day.temperatureLow ?? g.day.temperatureMin;
    if (hi === undefined || lo === undefined) continue;
    days.push({ mid: (g.startSec + g.endSec) / 2, hi, lo });
  }
  if (days.length >= 2) {
    const topPts = days.map((d) => ({ x: clampX(X(d.mid), gutter, right), y: y(d.hi) }));
    const botPts = days.map((d) => ({ x: clampX(X(d.mid), gutter, right), y: y(d.lo) }));
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = palette.temp;
    ctx.beginPath();
    ctx.moveTo(topPts[0].x, topPts[0].y);
    traceSmooth(ctx, topPts, 0, topPts.length, false);
    ctx.lineTo(botPts[botPts.length - 1].x, botPts[botPts.length - 1].y);
    const rev = botPts.slice().reverse();
    traceSmooth(ctx, rev, 0, rev.length, false);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Reference isotherms at freezing / room temperature, faint, when in range.
  ctx.font = dataFont(palette);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const r of tempRefs(env.units)) {
    if (r < tempLo || r > tempHi) continue;
    ctx.globalAlpha = 0.34;
    ctx.strokeStyle = palette.sub;
    ctx.lineWidth = palette.lineScale;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(gutter, y(r));
    ctx.lineTo(right, y(r));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = palette.sub;
    ctx.fillText(`${r}\u00B0`, right + 2, y(r));
  }
  ctx.globalAlpha = 1;

  // Hourly temperature and feels-like, alpha by time distance.
  const linePts: Pt[] = [];
  const appPts: Pt[] = [];
  for (const hr of model.hours) {
    const f = lineFade(hr.time - env.nowSec) * fade(hr.time);
    if (hr.temperature !== undefined) linePts.push({ x: X(hr.time), y: y(hr.temperature), w: f });
    if (hr.apparentTemperature !== undefined)
      appPts.push({ x: X(hr.time), y: y(hr.apparentTemperature), w: f * 0.85 });
  }
  strokeWeighted(ctx, appPts, palette.sub, 1.4 * palette.lineScale, [5, 4]);
  strokeWeighted(ctx, linePts, palette.temp, 2.4 * palette.lineScale);

  // Daily high/low dots and labels. Marker and number come as one unit, and
  // a day's H and L come as one atomic group: either both dots AND both
  // labels appear, or the day shows neither. A dot whose value is missing
  // reads as a bug, and an H without the neighboring L truncates the
  // envelope information. The smooth hi/lo envelope above still carries the
  // aggregate shape where groups are dropped.
  labels.reset();
  ctx.font = dataBoldFont(palette);
  ctx.textAlign = "center";
  ctx.fillStyle = palette.hiLo;
  for (const g of model.dayGroups) {
    const hi = g.day.temperatureHigh ?? g.day.temperatureMax;
    const lo = g.day.temperatureLow ?? g.day.temperatureMin;
    if (hi === undefined || lo === undefined) continue;
    const ht = g.day.temperatureHighTime ?? (g.startSec + g.endSec) / 2;
    const lt = g.day.temperatureLowTime ?? (g.startSec + g.endSec) / 2;
    const xh = clampX(X(ht), gutter, right);
    const xl = clampX(X(lt), gutter, right);
    const dayW = Math.abs(X(g.endSec) - X(g.startSec));
    if (dayW <= 34) continue;
    // Atomic per day: both labels must fit against prior placements AND not
    // collide with each other (H and L within one day are both 14 half-width).
    if (Math.abs(xh - xl) < 28) continue;
    if (!labels.fits(xh, 14) || !labels.fits(xl, 14)) continue;
    labels.tryPlace(xh, 14);
    labels.tryPlace(xl, 14);
    const f = Math.min(1, fade((g.startSec + g.endSec) / 2) + AGGREGATE_MIN_ALPHA);
    ctx.globalAlpha = f;
    ctx.beginPath();
    ctx.arc(xh, y(hi), 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(xl, y(lo), 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.textBaseline = "bottom";
    labelHalo(ctx, formatTemp(hi), xh, y(hi) - 3, palette.bg, 90);
    ctx.fillStyle = palette.hiLo;
    ctx.fillText(formatTemp(hi), xh, y(hi) - 3, 90);
    ctx.textBaseline = "top";
    labelHalo(ctx, formatTemp(lo), xl, y(lo) + 3, palette.bg, 90);
    ctx.fillStyle = palette.hiLo;
    ctx.fillText(formatTemp(lo), xl, y(lo) + 3, 90);
  }
  ctx.globalAlpha = 1;
}

// --- wind -------------------------------------------------------------------

function toKnots(speed: number, units: Units): number {
  switch (units) {
    case "si":
      return speed * 1.943_844;
    case "ca":
      return speed * 0.539_957;
    default:
      return speed * 0.868_976;
  }
}
/** Map a wind value to the band's Y axis, used by both the speed/gust line
 * and the hover crosshair dot so they never diverge. Linear in the value
 * (the windMax domain is the 95th percentile, set in prepare.ts, so the top
 * fills without a warp); a fixed top margin reserves room for the daily
 * max-gust label. */
export function windBandY(band: BandRect, v: number, windMax: number, lineScale: number): number {
  const labelTop = 15 * lineScale;
  const dataDepth = band.y1 - band.y0 - 2 * BAND_PAD - labelTop;
  return band.y1 - BAND_PAD - clamp01(v / windMax) * dataDepth;
}

/** WMO station-model wind barb. The shaft (18px) points toward the
 * direction the wind comes from (ctx.rotate(bearing)); the barbs and
 * pennant sit at that source end and splay OUT past the tip to the right
 * of the shaft -- toward low pressure in the Northern Hemisphere (Buys
 * Ballot). This matches the convention MetPy / NWS surface charts draw: a
 * north wind has low pressure to the east, so the feathers point east.
 *
 * Speed is rounded to the nearest 5 kt: pennant 50, full barb 10, half barb
 * from 2.5 up, calm circle below 2.5. A lone half barb (no full, no
 * pennant) is set back from the tip so it is not mistaken for a full barb
 * at the tip -- with nothing to compare length against, the two would be
 * indistinguishable (matplotlib: "easily distinguished from barbs with a
 * single full line"). With a full or pennant present the half sits right
 * below them in the normal stack, where its length is obvious by
 * comparison. */
function drawBarb(
  ctx: Ctx,
  x: number,
  y: number,
  bearingDeg: number,
  knots: number,
  color: string,
  halo: string,
) {
  const draw = (lw: number, stroke: string, fill: string | null) => {
    ctx.strokeStyle = stroke;
    ctx.fillStyle = fill ?? stroke;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    const shaftLen = 18;
    const baseY = 6;
    const tipY = baseY - shaftLen; // -12
    // Barb geometry scaled from matplotlib (12-pt shaft * 1.5). The free end
    // of each barb reaches toward the tip (-y) and out to +x, so the barbs
    // read as feathers splaying past the source end, not hooks folding back
    // onto the shaft toward the station.
    const FULL = 7.2; // perpendicular reach of a full barb
    const HALF = 3.6; // perpendicular reach of a half barb
    const RISE = 2.25; // how far each barb reaches back toward the tip
    const STEP = 2.25; // spacing between barbs down the shaft
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.lineTo(0, tipY);
    ctx.stroke();
    let kt = knots;
    let ty = tipY; // first mark (pennant or full) at the tip
    let hasFlagOrFull = false;
    // Pennants (50 kt each): a filled triangle, base on the shaft below the
    // tip, apex out to +x.
    while (kt >= 47.5) {
      ctx.beginPath();
      ctx.moveTo(0, ty);
      ctx.lineTo(FULL, ty + RISE);
      ctx.lineTo(0, ty + 2 * STEP);
      ctx.closePath();
      if (fill) ctx.fill();
      ctx.stroke();
      ty += 2 * STEP;
      kt -= 50;
      hasFlagOrFull = true;
    }
    // Full barbs (10 kt each).
    while (kt >= 10) {
      ctx.beginPath();
      ctx.moveTo(0, ty);
      ctx.lineTo(FULL, ty - RISE);
      ctx.stroke();
      ty += STEP;
      kt -= 10;
      hasFlagOrFull = true;
    }
    // Half barb (5 kt). When it is the only mark, offset it back from the
    // tip so it is not read as a full barb sitting at the tip.
    if (kt >= 2.5) {
      const hy = hasFlagOrFull ? ty : tipY + 1.5 * STEP;
      ctx.beginPath();
      ctx.moveTo(0, hy);
      ctx.lineTo(HALF, hy - RISE / 2);
      ctx.stroke();
    } else if (knots < 2.5) {
      ctx.beginPath();
      // Calm marker: a hollow circle at the station (the shaft's anchor
      // point), matching the MetPy / NWS convention -- no shaft, just the
      // circle where the station is. Hollow by default (fill_empty=False).
      ctx.arc(0, baseY, 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  };
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((bearingDeg * Math.PI) / 180);
  draw(4, halo, null);
  draw(2, color, color);
  ctx.restore();
}

/** Center-to-center px between wind barbs: fixed so barbs show at every
 * window width (more on wide, fewer on narrow) instead of vanishing when
 * the axis is compressed. */
const BARB_SPACING = 64;

export function drawWind(
  ctx: Ctx,
  model: Prepared,
  env: BandEnv,
  band: BandRect,
  X: (t: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
  gutter: number,
  right: number,
) {
  const { palette } = env;
  // Linear mapping with a fixed top margin for the max-gust label. The domain
  // is the 95th percentile (see prepare.ts), so the top fills without a sqrt
  // warp -- which would push low wind up and leave a gap at the bottom, and
  // (used only on the line) made the hover dot sit off the line. The crosshair
  // uses the same windBandY so the dot always sits on the line.
  const y = (v: number): number => windBandY(band, v, model.domains.windMax, palette.lineScale);

  const gustPts: Pt[] = [];
  const speedPts: Pt[] = [];
  for (const hr of model.hours) {
    const f = fade(hr.time);
    if (hr.windGust !== undefined) gustPts.push({ x: X(hr.time), y: y(hr.windGust), w: f * 0.75 });
    if (hr.windSpeed !== undefined) speedPts.push({ x: X(hr.time), y: y(hr.windSpeed), w: f });
  }
  strokeWeighted(ctx, gustPts, palette.sub, 1.4 * palette.lineScale);
  strokeWeighted(ctx, speedPts, palette.wind, 2.4 * palette.lineScale);

  labels.reset();
  for (const hr of model.hours) {
    if (hr.windBearing === undefined || hr.windSpeed === undefined) continue;
    const x = X(hr.time);
    if (x < gutter + 2) continue;
    if (!labels.tryPlace(x, BARB_SPACING / 2)) continue;
    ctx.globalAlpha = Math.min(1, fade(hr.time) * 0.95 + 0.1);
    drawBarb(
      ctx,
      x,
      y(hr.windSpeed),
      hr.windBearing,
      toKnots(hr.windSpeed, env.units),
      palette.wind,
      palette.bg,
    );
  }
  ctx.globalAlpha = 1;

  // Daily maximum gust: one dot + value per day, at the hour that peaked,
  // placed at the top of the band with a bg halo so it reads over the line.
  // Same gating as the temperature H/L markers: dot and value are atomic,
  // and dense days drop the whole marker (space-gated below).
  labels.reset();
  ctx.font = dataBoldFont(palette);
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const g of model.dayGroups) {
    let best = -Infinity;
    let bt: HourPoint | null = null;
    for (const hr of model.hours) {
      if (hr.time < g.startSec || hr.time >= g.endSec) continue;
      const v = hr.windGust ?? hr.windSpeed;
      if (v !== undefined && v > best) {
        best = v;
        bt = hr;
      }
    }
    if (!bt || best <= 0) continue;
    const dayW = Math.abs(X(g.endSec) - X(g.startSec));
    if (dayW <= 34) continue;
    const x = clampX(X(bt.time), gutter, right);
    const yy = y(best);
    if (!labels.tryPlace(x, 24)) continue;
    ctx.globalAlpha = Math.min(1, fade((g.startSec + g.endSec) / 2) + AGGREGATE_MIN_ALPHA);
    ctx.fillStyle = palette.bg;
    ctx.beginPath();
    ctx.arc(x, yy, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = palette.sub;
    ctx.beginPath();
    ctx.arc(x, yy, 2.4, 0, Math.PI * 2);
    ctx.fill();
    const text = `${best.toFixed(0)} ${windUnit(env.units)}`;
    // Clamp the label inside the band: when this day's gust clips at the top
    // (a rare outlier above the 95th-percentile domain), yy sits at the data
    // ceiling and the label above it would run into the divider; instead it
    // drops to just inside the band's padded top.
    const labelY = Math.max(yy - 5, band.y0 + BAND_PAD + 12);
    labelHalo(ctx, text, x, labelY, palette.bg);
    ctx.fillStyle = palette.sub;
    ctx.fillText(text, x, labelY);
  }
  ctx.globalAlpha = 1;
}

// --- cloud / UV -------------------------------------------------------------

// Three altitude lanes (low/mid/high cloud) as fractional positions of the
// band. Per-level soft ellipses are drawn around these centres, so each
// altitude reads at its own height while the lanes overlap where coverage
// is high.
const LANE_CENTERS = [0.25, 0.5, 0.75] as const;
// Per-level horizontal length and vertical thickness multipliers (low =
// short and thick like cumulus, high = long and thin like cirrus, mid
// between). Chosen look from the cloud-variants exploration; see
// wiki/weather-ui/cloud-visualization-exploration.md.
const CLOUD_LEN = [2.6, 1.7, 1.0] as const;
const CLOUD_THICK = [0.4, 0.75, 1.2] as const;
// Ellipse sample stride (px), coverage divisor (how many ellipses per
// sample), minimum overlap, base alpha, vertical size, lane-middle density
// falloff, and how far each lane drifts up/down over time.
const CLOUD_STEP = 6.5;
const CLOUD_DIV = 9;
const CLOUD_OVERLAP = 4;
const CLOUD_ALPHA = 0.4;
const CLOUD_VSIZE = 0.062;
const CLOUD_VFALLOFF = 0.11;
const CLOUD_VMOTION = 0.045;
const CLOUD_ROT_HIGH = 0.06;
const CLOUD_ROT_OTHER = 0.22;
// UV labels skip the low index values where the line is flat against the floor.
const UV_LABEL_MIN = 3;

function gauss(p: number, c: number, sigma: number): number {
  const d = (p - c) / sigma;
  return Math.exp(-d * d);
}

// Cheap continuous value noise in [0,1] for the slow lane drift.
function cloudNoise(x: number, y: number): number {
  const hash = (hx: number, hy: number) => {
    let h = (hx * 374761393 + hy * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Deterministic PRNG so a given hour+altitude renders the same shapes every
// frame (no shimmer) while the field still looks organic.
function cloudRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function drawCloud(
  ctx: Ctx,
  model: Prepared,
  env: BandEnv,
  band: BandRect,
  X: (t: number) => number,
  tAtX: (x: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
) {
  const { palette } = env;
  const bg = palette.bg;
  const y0 = band.y0;
  const y1 = band.y1;
  const depth = y1 - y0;
  const layers = model.cloudLayers;

  // Coverage at tSec for each lane, horizontally interpolated between
  // timestamps so there are no hard edges between hours. Mid falls back to
  // the per-hour cloudCover when no layer series is present.
  const midTimes = layers?.time ?? model.hours.map((h) => h.time);
  const midVals = layers?.mid ?? model.hours.map((h) => h.cloudCover ?? 0);
  const hiVals = layers?.high ?? [];
  const loVals = layers?.low ?? [];
  const cov = (tSec: number): [number, number, number] => [
    interpSeries(midTimes, hiVals, tSec),
    interpSeries(midTimes, midVals, tSec),
    interpSeries(midTimes, loVals, tSec),
  ];

  // Hybrid dense: per-level soft, horizontally-elongated ellipses sampled
  // at uniform screen spacing (fisheye-proof), denser in each lane's
  // vertical middle than its edges, with the lane centres drifting a little
  // over time so adjacent lanes overlap. Clipped to the band so the
  // ellipses cannot leak into the neighbouring bands.
  const ink = palette.cloudInk;
  const x0px = Math.ceil(X(model.hours[0].time));
  const x1px = Math.floor(X(model.hours[model.hours.length - 1].time));
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0px, y0, Math.max(1, x1px - x0px), depth);
  ctx.clip();
  for (let x = x0px; x < x1px; x += CLOUD_STEP) {
    const tSec = tAtX(x);
    const f = fade(tSec);
    const cs = cov(tSec);
    for (let li = 0; li < 3; li++) {
      const c = cs[li];
      if (c < 4) continue;
      const drift = (cloudNoise((tSec / 3600) * 0.02 + li * 31.7, 0) - 0.5) * 2 * CLOUD_VMOTION;
      const cy = y0 + (LANE_CENTERS[li] + drift) * depth;
      const n = Math.max(CLOUD_OVERLAP, Math.round(c / CLOUD_DIV));
      const gen = cloudRng((x | 0) * 7 + li * 131 + (tSec | 0) + 1);
      for (let k = 0; k < n; k++) {
        const jx = (gen() - 0.5) * CLOUD_STEP * 1.5;
        const jy = (gen() - 0.5) * 2 * CLOUD_VFALLOFF * depth;
        const falloff = gauss(jy / depth, 0, CLOUD_VFALLOFF);
        const rx = CLOUD_STEP * CLOUD_LEN[li] * (0.7 + gen() * 0.6);
        const ry = depth * CLOUD_VSIZE * CLOUD_THICK[li] * (0.7 + gen() * 0.6);
        const rot = (gen() - 0.5) * (li === 0 ? CLOUD_ROT_HIGH : CLOUD_ROT_OTHER);
        const cx = x + jx;
        const cyx = cy + jy;
        const grad = ctx.createRadialGradient(cx, cyx, 0, cx, cyx, Math.max(rx, ry));
        grad.addColorStop(0, ink);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = clamp01(c / 100) * CLOUD_ALPHA * falloff * f;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(cx, cyx, rx, ry, rot, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // UV index as a discrete step function, scaled so the data peak fills the
  // band. A bg-colored halo is stroked under the line so it stays visible
  // against both white and black clouds.
  const uvMax = model.domains.uvMax;
  const uvY = (v: number): number => bandY(band, v / uvMax);
  const uvPts: { x: number; y: number; v: number; t: number }[] = [];
  for (const hr of model.hours) {
    if (hr.uvIndex === undefined) continue;
    uvPts.push({ x: X(hr.time), y: uvY(hr.uvIndex), v: hr.uvIndex, t: hr.time });
  }
  const path = () => {
    if (uvPts.length < 2) return;
    // Draw only across contiguous non-zero runs: a step between hour i-1
    // and i is drawn only when both have UV > 0, so the long overnight
    // zero stretches draw nothing and the line never ramps to or from the
    // floor. A lone non-zero hour (no non-zero neighbour) draws nothing,
    // which is acceptable because UV is a smooth solar function that only
    // crosses zero at dawn/dusk and stays above it for several hours.
    ctx.beginPath();
    let inRun = false;
    for (let i = 1; i < uvPts.length; i++) {
      const prev = uvPts[i - 1];
      const cur = uvPts[i];
      if (prev.v > 0 && cur.v > 0) {
        if (!inRun) {
          ctx.moveTo(prev.x, prev.y);
          inRun = true;
        }
        ctx.lineTo(cur.x, prev.y);
        ctx.lineTo(cur.x, cur.y);
      } else {
        inRun = false;
      }
    }
  };
  ctx.strokeStyle = bg;
  ctx.lineWidth = 4 * palette.lineScale;
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.85;
  path();
  ctx.stroke();
  ctx.strokeStyle = palette.sub;
  ctx.lineWidth = 1.8 * palette.lineScale;
  ctx.globalAlpha = 0.95;
  path();
  ctx.stroke();
  ctx.globalAlpha = 1;

  // One UV max label per day, like the temp H/L and wind max-gust markers:
  // a single value at the day's peak, no dot. The UV plateau usually spans
  // a few midday hours, so the label centers on the whole max run (start of
  // the first max hour to the next value change) rather than a raw sample.
  labels.reset();
  ctx.font = dataFont(palette);
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const g of model.dayGroups) {
    // Hours belonging to this day (index-based, not position-based, so the
    // fisheye warp cannot misassign boundary hours).
    const dayPts = uvPts.filter((p) => p.t >= g.startSec && p.t < g.endSec);
    if (dayPts.length === 0) continue;
    let maxV = -1;
    for (const p of dayPts) if (p.v > maxV) maxV = p.v;
    if (maxV < UV_LABEL_MIN) continue;
    const firstMax = dayPts.find((p) => p.v === maxV);
    if (!firstMax) continue;
    let runEndX = firstMax.x;
    const gi = uvPts.indexOf(firstMax);
    let k = gi;
    while (k < uvPts.length && uvPts[k].v === maxV && uvPts[k].t < g.endSec) {
      runEndX = k + 1 < uvPts.length ? uvPts[k + 1].x : uvPts[k].x;
      k++;
    }
    const cx = (firstMax.x + runEndX) / 2;
    const dayW = Math.abs(X(g.endSec) - X(g.startSec));
    // Same atomic gate as the wind max-gust label: a day squeezed below the
    // label width loses its marker entirely; the step profile still shows.
    if (dayW <= 34) continue;
    if (!labels.tryPlace(cx, 8)) continue;
    const text = String(Math.round(maxV));
    ctx.globalAlpha = Math.min(1, fade(firstMax.t) + AGGREGATE_MIN_ALPHA);
    labelHalo(ctx, text, cx, uvY(maxV) - 2, bg);
    ctx.fillStyle = palette.sub;
    ctx.fillText(text, cx, uvY(maxV) - 2);
  }
  ctx.globalAlpha = 1;
}
