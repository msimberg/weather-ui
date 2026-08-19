// The canvas renderer. One pass per frame: night shading, four data bands
// (precip, temp, wind, cloud), the two-tier axis, then a fade-to-the-past
// overlay. Detail is density-driven: hourly lines, labels, and glyphs only
// appear where the warp gives them pixels; where it does not, the daily
// min/max envelope and per-day labels take over. Styling aims for a quiet
// scientific chart: monochrome inks, one muted hue for temperature, mono
// numerals, dashed midnight dividers.

import { drawIcon, type IconStyle } from "./icons";
import { formatTemp } from "./format";
import { formatHour } from "./time";
import {
  clamp01,
  lineWeight,
  MIN_PAST_ALPHA,
  pastFade,
  type TimeAxis,
} from "./transform";
import type { Prepared } from "./prepare";
import type { HourPoint, Units } from "./types";

export interface Palette {
  bg: string;
  fg: string;
  sub: string;
  grid: string;
  night: string;
  now: string;
  temp: string;
  appTemp: string;
  hiLo: string;
  rain: string;
  snow: string;
  ice: string;
  prob: string;
  wind: string;
  gust: string;
  cloudInk: string;
  uv: string;
  layerLo: string;
  layerMid: string;
  layerHi: string;
}

export const LIGHT: Palette = {
  bg: "#faf9f6",
  fg: "#17191d",
  sub: "#59606a",
  grid: "rgba(23, 25, 29, 0.16)",
  night: "rgba(23, 25, 29, 0.05)",
  now: "#17191d",
  temp: "#17191d",
  appTemp: "rgba(23, 25, 29, 0.5)",
  hiLo: "#17191d",
  rain: "#17191d",
  snow: "#6b7480",
  ice: "#8b96a3",
  prob: "#3d444b",
  wind: "#17191d",
  gust: "rgba(23, 25, 29, 0.5)",
  cloudInk: "#17191d",
  uv: "#3d444b",
  layerLo: "#17191d",
  layerMid: "#59606a",
  layerHi: "#8b96a3",
};

export const DARK: Palette = {
  bg: "#0e1013",
  fg: "#e6e3de",
  sub: "#8a93a0",
  grid: "rgba(230, 227, 222, 0.14)",
  night: "rgba(230, 227, 222, 0.045)",
  now: "#e6e3de",
  temp: "#e6e3de",
  appTemp: "rgba(230, 227, 222, 0.5)",
  hiLo: "#e6e3de",
  rain: "#c9cfda",
  snow: "#f2efeb",
  ice: "#a3adbd",
  prob: "#828c99",
  wind: "#e6e3de",
  gust: "rgba(230, 227, 222, 0.5)",
  cloudInk: "#e6e3de",
  uv: "#828c99",
  layerLo: "#e6e3de",
  layerMid: "#a9b0bc",
  layerHi: "#6f7785",
};
export function iconStyle(p: Palette): IconStyle {
  return { ink: p.fg, accent: p.temp };
}

export const UI_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export interface ViewOptions {
  nowSec: number;
  axis: TimeAxis;
  units: Units;
  palette: Palette;
  hoverSec: number | null;
  layout: "full" | "compact";
  cloudViz: "density" | "area";
}

interface Pt {
  x: number;
  y: number;
  w: number;
}

const AXIS_H = 40;
const TOP_PAD = 6;
const BAND_PAD = 5;

type Ctx = CanvasRenderingContext2D;

function quantizeWeight(w: number): number {
  return Math.round(w * 8) / 8;
}

/** Trace pts[i0..i1) as a smooth open curve: data points become control
 * points of quadratic segments anchored at segment midpoints. When move is
 * false the caller must have the current point at pts[i0] (used when the
 * curve is one edge of a closed region). */
function traceSmooth(
  ctx: Ctx,
  pts: readonly { x: number; y: number }[],
  i0: number,
  i1: number,
  move = true,
) {
  if (i1 - i0 < 2) return;
  if (move) ctx.moveTo(pts[i0].x, pts[i0].y);
  if (i1 - i0 === 2) {
    ctx.lineTo(pts[i1 - 1].x, pts[i1 - 1].y);
    return;
  }
  for (let i = i0 + 1; i < i1 - 1; i++) {
    const midX = (pts[i].x + pts[i + 1].x) / 2;
    const midY = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
  }
  ctx.lineTo(pts[i1 - 1].x, pts[i1 - 1].y);
}

/** Stroke a smoothed series whose per-vertex weight w controls alpha.
 * Adjacent alpha buckets overlap by one vertex so the line stays continuous
 * through the fade crossfade; vertices at weight ~0 end the run there. */
function strokeWeighted(ctx: Ctx, pts: Pt[], style: string, width: number, dash?: number[]) {
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (dash) ctx.setLineDash(dash);
  const n = pts.length;
  let i = 0;
  while (i < n) {
    if (quantizeWeight(pts[i].w) <= 0.05) {
      i++;
      continue;
    }
    const bucket = quantizeWeight(pts[i].w);
    let j = i + 1;
    while (j < n && quantizeWeight(pts[j].w) === bucket) j++;
    ctx.globalAlpha = bucket;
    ctx.beginPath();
    // Include one extra vertex so the next bucket reconnects seamlessly.
    traceSmooth(ctx, pts, i, Math.min(j + 1, n));
    ctx.stroke();
    i = j;
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

interface GreedyLabels {
  reset(): void;
  tryPlace(x: number, halfWidth: number): boolean;
}

function makeGreedyLabels(): GreedyLabels {
  const taken: { lo: number; hi: number }[] = [];
  return {
    reset() {
      taken.length = 0;
    },
    tryPlace(x: number, halfWidth: number) {
      const lo = x - halfWidth;
      const hi = x + halfWidth;
      for (const t of taken) {
        if (lo <= t.hi && hi >= t.lo) return false;
      }
      taken.push({ lo, hi });
      return true;
    },
  };
}

interface Bands {
  precip: { y0: number; y1: number };
  temp: { y0: number; y1: number };
  wind: { y0: number; y1: number };
  cloud: { y0: number; y1: number };
  top: number;
  bottom: number;
}

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

  const gutter = Math.max(44, Math.min(64, cssW * 0.075));
  const X = (tSec: number): number => gutter + axis.t2x(tSec * 1000);
  const Xnow = gutter + axis.cx;
  const right = cssW - 6;
  const density = (tSec: number): number => axis.pxPerHour(tSec * 1000);
  const fade = (tSec: number): number => pastFade(tSec * 1000, axis.now, axis.pastMs);

  let top = TOP_PAD;
  const axisTop = cssH - AXIS_H;
  let bandsH = axisTop - top;
  if (view.layout === "compact") {
    // Shorter bands centered vertically; the margin sliders the whole chart
    // away from full-bleed without changing geometry inside it.
    const target = Math.max(210, Math.min(cssH * 0.42, bandsH));
    const extra = bandsH - target;
    top += extra / 2;
    bandsH = target;
  }
  const bands: Bands = {
    precip: { y0: top, y1: top + bandsH * 0.16 },
    temp: { y0: 0, y1: 0 },
    wind: { y0: 0, y1: 0 },
    cloud: { y0: 0, y1: 0 },
    top,
    bottom: axisTop,
  };
  bands.temp = { y0: bands.precip.y1 + 4, y1: bands.precip.y1 + 4 + bandsH * 0.4 };
  bands.wind = { y0: bands.temp.y1 + 4, y1: bands.temp.y1 + 4 + bandsH * 0.19 };
  bands.cloud = { y0: bands.wind.y1 + 4, y1: top + bandsH };
  bands.bottom = bands.cloud.y1;

  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // Night shading and dashed midnight dividers under everything else.
  ctx.fillStyle = palette.night;
  for (const span of model.nights) {
    const x0 = Math.max(gutter, X(span.startSec));
    const x1 = Math.min(right, X(span.endSec));
    if (x1 > x0) ctx.fillRect(x0, bands.top, x1 - x0, bands.bottom - bands.top);
  }
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  for (const g of model.dayGroups) {
    const x = X(g.startSec);
    if (x > gutter + 2 && x < right - 1) {
      ctx.beginPath();
      ctx.moveTo(x, bands.top);
      ctx.lineTo(x, bands.bottom + 16);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  const labels = makeGreedyLabels();

  drawPrecip(ctx, model, view, bands.precip, X, fade, labels, gutter, right);
  drawTemp(ctx, model, view, bands.temp, X, density, fade, labels, gutter, right);
  drawWind(ctx, model, view, bands.wind, X, density, fade, labels);
  drawCloud(ctx, model, view, bands.cloud, X, density, fade, labels);

  // Fade everything data-ward of now, linearly toward MIN_PAST_ALPHA at the
  // left edge. destination-out erases opacity, leaving chrome untouched.
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  const grad = ctx.createLinearGradient(gutter, 0, Xnow, 0);
  const eraseMax = 1 - MIN_PAST_ALPHA;
  for (let i = 0; i <= 8; i++) {
    const u = i / 8;
    grad.addColorStop(u, `rgba(0, 0, 0, ${eraseMax * (1 - u)})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(gutter, bands.top, Xnow - gutter, bands.bottom - bands.top);
  ctx.restore();

  drawBandChrome(ctx, palette, gutter, right, [
    { band: bands.precip, title: "PRECIP", legend: ["bars intensity", "line probability"] },
    { band: bands.temp, title: "TEMP", legend: ["solid temp", "dashed feels-like"] },
    { band: bands.wind, title: "WIND", legend: ["solid speed, thin gust", "barbs: dir + kt class"] },
    {
      band: bands.cloud,
      title: "CLOUD / UV",
      legend:
        view.cloudViz === "density"
          ? ["shade = total cover", "solid/dash: low/mid/high", "line: UV"]
          : ["area: total cover", "line: UV"],
    },
  ]);

  drawAxis(ctx, model, view, axisTop, X, density, gutter, right);
  drawNow(ctx, palette, Xnow, bands.top, cssH);

  if (hoverSec !== null) {
    drawCrosshair(ctx, model, view, hoverSec, X, bands);
  }
}

function trimNum(v: number): string {
  return Math.abs(v) >= 20 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
}

/** y-map for a 0..1 fraction of a band's inner depth. */
function bandY(band: { y0: number; y1: number }, v: number): number {
  const depth = band.y1 - band.y0 - 2 * BAND_PAD;
  return band.y1 - BAND_PAD - clamp01(v) * depth;
}

/** Linear interpolation of a property between its neighboring samples. */
function interpAt(
  hours: HourPoint[],
  tSec: number,
  pick: (h: HourPoint) => number | undefined,
): number | null {
  let before: number | undefined;
  let after: number | undefined;
  let bT = -Infinity;
  let aT = Infinity;
  for (const h of hours) {
    const v = pick(h);
    if (v === undefined || Number.isNaN(v)) continue;
    if (h.time <= tSec && h.time >= bT) {
      bT = h.time;
      before = v;
    }
    if (h.time >= tSec && h.time <= aT) {
      aT = h.time;
      after = v;
    }
  }
  if (before === undefined) return after ?? null;
  if (after === undefined) return before;
  if (aT === bT) return before;
  const f = (tSec - bT) / (aT - bT);
  return before + f * (after - before);
}

// --- precip ----------------------------------------------------------------

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

/** Column width from neighbor spacing so bars tile the axis as a histogram. */
function slotWidth(xs: number[], i: number, cap: number): number {
  const here = xs[i];
  const prev = i > 0 ? xs[i - 1] : here * 2 - (xs[i + 1] ?? here);
  const next = i < xs.length - 1 ? xs[i + 1] : 2 * here - prev;
  const slot = Math.min(here - prev, next - here);
  return Math.max(1.2, Math.min(cap, slot * 0.98));
}

function drawPrecip(
  ctx: Ctx,
  model: Prepared,
  view: ViewOptions,
  band: { y0: number; y1: number },
  X: (t: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
  gutter: number,
  right: number,
) {
  const { palette } = view;
  const depth = band.y1 - band.y0 - 2 * BAND_PAD;
  const base = band.y1 - BAND_PAD;
  const pxMax = model.domains.precipMax;
  const h = (v: number): number => Math.max(1, Math.sqrt(Math.min(1, v / pxMax)) * (depth - 2));

  const probPts: Pt[] = [];
  for (const hr of model.hours) {
    if (hr.precipProbability === undefined) continue;
    probPts.push({
      x: X(hr.time),
      y: band.y0 + BAND_PAD + (1 - clamp01(hr.precipProbability)) * depth,
      w: 0.75 * fade(hr.time),
    });
  }

  // Histogram bars filling each hour slot, with the API's intensity error
  // as a soft vertical halo where upstream reports one.
  const xs = model.hours.map((hr) => X(hr.time));
  for (let i = 0; i < model.hours.length; i++) {
    const hr = model.hours[i];
    const v = hr.precipIntensity ?? 0;
    const err = hr.precipIntensityError ?? 0;
    const w = fade(hr.time);
    const bw = slotWidth(xs, i, 22);
    if (err > 0.02 && v + err > 0.01) {
      const lo = Math.max(0, v - err);
      ctx.globalAlpha = 0.18 * w;
      ctx.fillStyle = precipColor(hr.precipType, palette);
      ctx.fillRect(xs[i] - bw / 2, base - h(v + err), bw, Math.max(1, h(v + err) - h(lo)));
    }
    if (v > 0.01) {
      ctx.globalAlpha = 0.92 * w;
      ctx.fillStyle = precipColor(hr.precipType, palette);
      ctx.fillRect(xs[i] - bw / 2, base - h(v), bw, h(v));
    }
  }

  // Minutely bars in the near-future window, where pixels allow them.
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

  strokeWeighted(ctx, probPts, palette.prob, 1.4);

  // Per-day accumulation totals where the day has room.
  labels.reset();
  ctx.font = `10px ${UI_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const g of model.dayGroups) {
    const accum = g.day.precipAccumulation;
    if (accum === undefined || accum <= 0.2) continue;
    const x0 = Math.max(gutter, X(g.startSec));
    const x1 = Math.min(right, X(g.endSec));
    if (x1 - x0 < 36) continue;
    const cx = (x0 + x1) / 2;
    if (!labels.tryPlace(cx, 20)) continue;
    const mid = (g.startSec + g.endSec) / 2;
    ctx.globalAlpha = Math.min(1, fade(mid) + 0.15);
    ctx.fillStyle = palette.sub;
    const text = view.units === "us" ? `${accum.toFixed(2)}in` : `${(accum * 10).toFixed(accum * 10 < 10 ? 1 : 0)}mm total`;
    ctx.fillText(text, cx, band.y0 + BAND_PAD, 90);
  }
  ctx.globalAlpha = 1;
}

// --- temperature -------------------------------------------------------------

function drawTemp(
  ctx: Ctx,
  model: Prepared,
  view: ViewOptions,
  band: { y0: number; y1: number },
  X: (t: number) => number,
  density: (t: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
  gutter: number,
  right: number,
) {
  const { palette } = view;
  const { tempLo, tempHi } = model.domains;
  const y = (v: number): number =>
    band.y1 - BAND_PAD - ((v - tempLo) / (tempHi - tempLo)) * (band.y1 - band.y0 - 2 * BAND_PAD);

  // Smooth min/max envelope over the days where the band dominates: a
  // smoothed closed region through daily extreme midpoints, replacing the
  // earlier per-day rectangles.
  interface DayExt {
    mid: number;
    hi: number;
    lo: number;
    w: number;
  }
  const days: DayExt[] = [];
  for (const g of model.dayGroups) {
    const hi = g.day.temperatureHigh ?? g.day.temperatureMax;
    const lo = g.day.temperatureLow ?? g.day.temperatureMin;
    if (hi === undefined || lo === undefined) continue;
    const mid = (g.startSec + g.endSec) / 2;
    days.push({ mid, hi, lo, w: (1 - lineWeight(density(mid))) * fade(mid) });
  }
  let run: DayExt[] = [];
  const flushEnvelope = () => {
    if (run.length === 0) return;
    const topPts = run.map((d) => ({ x: Math.max(gutter, Math.min(right, X(d.mid))), y: y(d.hi) }));
    const botPts = run.map((d) => ({ x: Math.max(gutter, Math.min(right, X(d.mid))), y: y(d.lo) }));
    const alpha = Math.min(0.3, Math.max(0, (run.reduce((a, d) => a + d.w, 0) / run.length) * 0.34));
    if (alpha > 0.02 && (topPts[topPts.length - 1].x - topPts[0].x) > 3) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = palette.temp;
      ctx.beginPath();
      ctx.moveTo(topPts[0].x, topPts[0].y);
      traceSmooth(ctx, topPts, 0, topPts.length, false);
      ctx.lineTo(botPts[botPts.length - 1].x, botPts[botPts.length - 1].y);
      const rev = botPts.slice().reverse();
      traceSmooth(ctx, rev, 0, rev.length, false);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = Math.min(1, alpha * 2.2);
      ctx.strokeStyle = palette.temp;
      ctx.lineWidth = 1;
      ctx.beginPath();
      traceSmooth(ctx, topPts, 0, topPts.length);
      ctx.stroke();
      ctx.beginPath();
      traceSmooth(ctx, botPts, 0, botPts.length);
      ctx.stroke();
    }
    run = [];
  };
  for (const d of days) {
    if (d.w < 0.02) {
      flushEnvelope();
      continue;
    }
    run.push(d);
  }
  flushEnvelope();

  const linePts: Pt[] = [];
  const appPts: Pt[] = [];
  for (const hr of model.hours) {
    const w = lineWeight(density(hr.time)) * fade(hr.time);
    if (hr.temperature !== undefined) linePts.push({ x: X(hr.time), y: y(hr.temperature), w });
    if (hr.apparentTemperature !== undefined)
      appPts.push({ x: X(hr.time), y: y(hr.apparentTemperature), w: w * 0.85 });
  }
  strokeWeighted(ctx, linePts, palette.temp, 2.4);
  strokeWeighted(ctx, appPts, palette.appTemp, 1.4, [5, 4]);

  // Gridlines and gutter ticks at nice steps.
  const step = niceStep((tempHi - tempLo) / 4);
  ctx.font = `12px ${UI_FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let v = Math.ceil(tempLo / step) * step; v <= tempHi; v += step) {
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(gutter, y(v));
    ctx.lineTo(right, y(v));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.sub;
    ctx.fillText(trimNum(v), gutter - 5, y(v));
  }

  // Daily H/L labels where the envelope dominates.
  labels.reset();
  ctx.font = `12px ${UI_FONT}`;
  ctx.fillStyle = palette.hiLo;
  ctx.textAlign = "center";
  for (const g of model.dayGroups) {
    const hi = g.day.temperatureHigh ?? g.day.temperatureMax;
    const lo = g.day.temperatureLow ?? g.day.temperatureMin;
    if (hi === undefined || lo === undefined) continue;
    const mid = (g.startSec + g.endSec) / 2;
    const w = (1 - lineWeight(density(mid))) * fade(mid);
    const width = Math.min(right, X(g.endSec)) - Math.max(gutter, X(g.startSec));
    if (w < 0.3 || width < 34) continue;
    const cx = Math.max(gutter + width / 2, Math.min(right - width / 2, X(mid)));
    if (labels.tryPlace(cx, 16)) {
      ctx.globalAlpha = Math.min(1, w + 0.25);
      ctx.textBaseline = "bottom";
      ctx.fillText(formatTemp(hi), cx, y(hi) - 2);
      ctx.textBaseline = "top";
      ctx.fillText(formatTemp(lo), cx, y(lo) + 2);
    }
  }
  ctx.globalAlpha = 1;

  // Hourly temperature values and icons where dense enough.
  labels.reset();
  const iconRowY = band.y0 + BAND_PAD;
  for (const hr of model.hours) {
    const d = density(hr.time);
    const w = lineWeight(d) * fade(hr.time);
    if (d > 24 && hr.temperature !== undefined && w > 0.5) {
      const text = formatTemp(hr.temperature);
      ctx.font = `12px ${UI_FONT}`;
      const tw = ctx.measureText(text).width / 2 + 5;
      if (labels.tryPlace(X(hr.time), tw)) {
        ctx.globalAlpha = Math.min(1, w + 0.25);
        ctx.fillStyle = palette.fg;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(text, X(hr.time), y(hr.temperature) - 3);
        if (d > 40 && hr.icon) {
          drawIcon(ctx, hr.icon, X(hr.time) - 6, iconRowY, 12, iconStyle(palette));
        }
      }
    }
  }
  ctx.globalAlpha = 1;

  // One icon per compressed day in envelope regions.
  const dayIconDone = new Set<number>();
  for (const g of model.dayGroups) {
    const mid = (g.startSec + g.endSec) / 2;
    if (lineWeight(density(mid)) > 0.25 || !g.day.icon) continue;
    const width = Math.min(right, X(g.endSec)) - Math.max(gutter, X(g.startSec));
    if (width < 24 || dayIconDone.has(g.startSec)) continue;
    dayIconDone.add(g.startSec);
    const cx = Math.max(gutter + width / 2, Math.min(right - width / 2, X(mid)));
    ctx.globalAlpha = fade(mid) * 0.9;
    drawIcon(ctx, g.day.icon, cx - 6, iconRowY, 12, iconStyle(palette));
  }
  ctx.globalAlpha = 1;
}

function niceStep(rough: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / mag;
  return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10) * mag;
}

// --- wind -------------------------------------------------------------

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

/** WMO station-model wind barb: shaft points to where the wind comes FROM,
 * feathers at the tail: pennant 50 kt, long barb 10 kt, short barb 5 kt. */
function drawBarb(ctx: Ctx, x: number, y: number, bearingDeg: number, knots: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((bearingDeg * Math.PI) / 180);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.3;
  ctx.lineCap = "round";
  const shaftLen = 13;
  ctx.beginPath();
  ctx.moveTo(0, 5);
  ctx.lineTo(0, 5 - shaftLen);
  ctx.stroke();
  let kt = knots;
  let ty = 5 - shaftLen;
  while (kt >= 47.5) {
    ctx.beginPath();
    ctx.moveTo(0, ty);
    ctx.lineTo(-6.5, ty + 4);
    ctx.lineTo(0, ty + 8);
    ctx.closePath();
    ctx.fill();
    ty += 2.5;
    kt -= 50;
  }
  while (kt >= 10) {
    ctx.beginPath();
    ctx.moveTo(0, ty);
    ctx.lineTo(-6, ty + 4.6);
    ctx.stroke();
    ty += 4;
    kt -= 10;
  }
  if (kt >= 5) {
    ctx.beginPath();
    ctx.moveTo(0, ty);
    ctx.lineTo(-3, ty + 2.3);
    ctx.stroke();
  } else if (kt < 2.5 && knots < 2.5) {
    // Calm: a small ring floating on the line.
    ctx.beginPath();
    ctx.arc(0, -2, 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWind(
  ctx: Ctx,
  model: Prepared,
  view: ViewOptions,
  band: { y0: number; y1: number },
  X: (t: number) => number,
  density: (t: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
) {
  const { palette } = view;
  const y = (v: number): number => bandY(band, v / model.domains.windMax);

  const gustPts: Pt[] = [];
  const speedPts: Pt[] = [];
  for (const hr of model.hours) {
    const w = fade(hr.time);
    if (hr.windGust !== undefined) gustPts.push({ x: X(hr.time), y: y(hr.windGust), w: w * 0.75 });
    if (hr.windSpeed !== undefined) speedPts.push({ x: X(hr.time), y: y(hr.windSpeed), w });
  }
  strokeWeighted(ctx, gustPts, palette.gust, 1.4);
  strokeWeighted(ctx, speedPts, palette.wind, 2.4);

  labels.reset();
  for (const hr of model.hours) {
    if (hr.windBearing === undefined || hr.windSpeed === undefined) continue;
    if (density(hr.time) < 13 || !labels.tryPlace(X(hr.time), 17)) continue;
    ctx.globalAlpha = fade(hr.time) * 0.95;
    drawBarb(ctx, X(hr.time), y(hr.windSpeed), hr.windBearing, toKnots(hr.windSpeed, view.units), palette.wind);
  }
  ctx.globalAlpha = 1;
}

// --- cloud / uv -------------------------------------------------------------

function drawCloud(
  ctx: Ctx,
  model: Prepared,
  view: ViewOptions,
  band: { y0: number; y1: number },
  X: (t: number) => number,
  density: (t: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
) {
  const { palette } = view;
  const depth = band.y1 - band.y0 - 2 * BAND_PAD;

  if (view.cloudViz === "density") {
    // Darkness per column = total cloud fraction. Tiles the axis as a density
    // strip; the past fade overlay dims it with everything else.
    const xs = model.hours.map((hr) => X(hr.time));
    ctx.fillStyle = palette.cloudInk;
    for (let i = 0; i < model.hours.length; i++) {
      const cover = model.hours[i].cloudCover;
      if (cover === undefined || cover < 0.04) continue;
      const prev = i > 0 ? xs[i - 1] : xs[i] - 2;
      const next = i < xs.length - 1 ? xs[i + 1] : xs[i] + 2;
      const x0 = Math.min(xs[i], (prev + xs[i]) / 2);
      const x1 = Math.max(xs[i], (next + xs[i]) / 2);
      ctx.globalAlpha = clamp01(cover) * 0.3;
      ctx.fillRect(x0, band.y0 + BAND_PAD, Math.max(0.6, x1 - x0), depth);
    }
    ctx.globalAlpha = 1;

    // Open-Meteo altitude layers as three hairlines: solid low, dashed mid,
    // short-dash high.
    const layers = model.cloudLayers;
    if (layers) {
      const mkPts = (vals: number[]): Pt[] => {
        const pts: Pt[] = [];
        const n = Math.min(vals.length, layers.time.length);
        for (let i = 0; i < n; i++) {
          const v = vals[i];
          if (v === undefined || Number.isNaN(v)) continue;
          pts.push({ x: X(layers.time[i]), y: bandY(band, v / 100), w: 0.85 * fade(layers.time[i]) });
        }
        return pts;
      };
      strokeWeighted(ctx, mkPts(layers.low), palette.layerLo, 1.0);
      strokeWeighted(ctx, mkPts(layers.mid), palette.layerMid, 1, [7, 4]);
      strokeWeighted(ctx, mkPts(layers.high), palette.layerHi, 0.9, [2.5, 3]);
    }
  } else {
    // Legacy area rendering of total cloud cover.
    let run: { x: number; y: number }[] = [];
    const flush = () => {
      if (run.length < 2) {
        run = [];
        return;
      }
      ctx.beginPath();
      ctx.moveTo(run[0].x, band.y1 - BAND_PAD);
      ctx.lineTo(run[0].x, run[0].y);
      traceSmooth(ctx, run, 0, run.length, false);
      ctx.lineTo(run[run.length - 1].x, band.y1 - BAND_PAD);
      ctx.closePath();
      ctx.fill();
      run = [];
    };
    for (const hr of model.hours) {
      if (hr.cloudCover === undefined) {
        flush();
        continue;
      }
      run.push({ x: X(hr.time), y: bandY(band, hr.cloudCover) });
    }
    ctx.fillStyle = palette.cloudInk;
    ctx.globalAlpha = 0.22;
    flush();
    ctx.globalAlpha = 1;
  }

  // UV line on top in both modes.
  const uvPts: Pt[] = [];
  for (const hr of model.hours) {
    if (hr.uvIndex === undefined) continue;
    uvPts.push({ x: X(hr.time), y: bandY(band, hr.uvIndex / 11), w: fade(hr.time) * 0.95 });
  }
  strokeWeighted(ctx, uvPts, palette.uv, 1.6);

  labels.reset();
  ctx.font = `10px ${UI_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const hr of model.hours) {
    if (hr.uvIndex === undefined || hr.uvIndex < 3) continue;
    if (density(hr.time) < 9 || !labels.tryPlace(X(hr.time), 10)) continue;
    ctx.globalAlpha = fade(hr.time);
    ctx.fillStyle = palette.uv;
    ctx.fillText(String(Math.round(hr.uvIndex)), X(hr.time), bandY(band, hr.uvIndex / 11) - 2);
  }
  ctx.globalAlpha = 1;
}

// --- chrome -------------------------------------------------------------

interface BandChrome {
  band: { y0: number; y1: number };
  title: string;
  legend: string[];
}

function drawBandChrome(ctx: Ctx, palette: Palette, gutter: number, right: number, entries: BandChrome[]) {
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  for (const { band, title, legend } of entries) {
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(gutter, band.y1 + 2);
    ctx.lineTo(right, band.y1 + 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.sub;
    ctx.font = `600 9px ${UI_FONT}`;
    ctx.fillText(title, 5, band.y0 + 4);
    ctx.font = `9px ${UI_FONT}`;
    legend.forEach((line, i) => {
      ctx.fillText(line, 5, band.y0 + 16 + i * 10, gutter - 8);
    });
  }
}

function drawAxis(
  ctx: Ctx,
  model: Prepared,
  _view: ViewOptions,
  axisTop: number,
  X: (t: number) => number,
  density: (t: number) => number,
  gutter: number,
  right: number,
) {
  const { palette } = _view;
  const dayLabelY = axisTop + 4;
  const hourLabelY = axisTop + 22;

  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  ctx.font = `600 12px ${UI_FONT}`;
  ctx.fillStyle = palette.fg;
  for (const g of model.dayGroups) {
    const x0 = Math.max(gutter, X(g.startSec));
    const x1 = Math.min(right, X(g.endSec));
    if (x1 - x0 < 44) continue;
    ctx.fillText(g.label, (x0 + x1) / 2, dayLabelY);
  }

  const taken: number[] = [];
  ctx.font = `12px ${UI_FONT}`;
  for (const hr of model.hours) {
    if (density(hr.time) < 9) continue;
    const x = X(hr.time);
    if (x < gutter + 4 || x > right - 4) continue;
    const text = formatHour(model.timezone, hr.time);
    const hw = ctx.measureText(text).width / 2 + 4;
    let ok = true;
    for (const t of taken) {
      if (Math.abs(t - x) < hw + 12) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    taken.push(x);
    ctx.fillStyle = palette.grid;
    ctx.fillRect(x - 0.5, axisTop + 16, 1, 3);
    ctx.fillStyle = palette.sub;
    ctx.fillText(text, x, hourLabelY);
  }
}

function drawNow(ctx: Ctx, palette: Palette, x: number, y0: number, cssH: number) {
  ctx.strokeStyle = palette.now;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, cssH - 18);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.font = `600 11px ${UI_FONT}`;
  ctx.fillStyle = palette.now;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText("now", x + 4, cssH - 18);
}

function drawCrosshair(
  ctx: Ctx,
  model: Prepared,
  view: ViewOptions,
  hoverSec: number,
  X: (t: number) => number,
  bands: Bands,
) {
  const x = X(hoverSec);
  const { palette } = view;
  ctx.globalAlpha = 0.65;
  ctx.strokeStyle = palette.fg;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x, bands.top);
  ctx.lineTo(x, bands.bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  const dot = (value: number | null, yOf: (v: number) => number, color: string, r = 3) => {
    if (value === null) return;
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, yOf(value), r, 0, Math.PI * 2);
    ctx.fill();
  };

  if (lineWeight(view.axis.pxPerHour(hoverSec * 1000)) > 0.05) {
    const { tempLo, tempHi } = model.domains;
    const yTemp = (v: number) =>
      bands.temp.y1 -
      BAND_PAD -
      ((v - tempLo) / (tempHi - tempLo)) * (bands.temp.y1 - bands.temp.y0 - 2 * BAND_PAD);
    dot(interpAt(model.hours, hoverSec, (h) => h.temperature), yTemp, palette.temp, 3.5);
  }
  dot(
    interpAt(model.hours, hoverSec, (h) => h.windSpeed),
    (v) => bandY(bands.wind, v / model.domains.windMax),
    palette.wind,
  );
  dot(
    interpAt(model.hours, hoverSec, (h) => h.uvIndex),
    (v) => bandY(bands.cloud, v / 11),
    palette.uv,
    2.5,
  );
  dot(
    interpAt(model.hours, hoverSec, (h) => h.precipProbability),
    (v) => bandY(bands.precip, v),
    palette.prob,
    2.5,
  );
  ctx.globalAlpha = 1;
}
