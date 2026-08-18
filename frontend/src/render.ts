// The canvas renderer. Given the prepared model and a time axis it draws the
// full scene in one pass: night shading, four data bands (precip, temp, wind,
// cloud/uv), day/hour axis tiers, then a fade-to-the-past overlay. Detail is
// density-driven: hourly lines, labels, and icons only appear where the warp
// gives them enough pixels; where it does not, the daily min/max band and
// per-day labels take over. That crossfade is what makes the axis feel
// continuous instead of tiered.

import { drawIcon } from "./icons";
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
  band: string;
  hiLo: string;
  rain: string;
  snow: string;
  ice: string;
  prob: string;
  wind: string;
  gust: string;
  cloud: string;
  uv: string;
}

export const DARK: Palette = {
  bg: "#0d1117",
  fg: "#dde6ee",
  sub: "#7f8d9b",
  grid: "rgba(127, 141, 155, 0.22)",
  night: "rgba(74, 111, 199, 0.13)",
  now: "#e8c04a",
  temp: "#ef6759",
  appTemp: "rgba(239, 103, 89, 0.55)",
  band: "#ef6759",
  hiLo: "#c7d3dd",
  rain: "#57a0f5",
  snow: "#d4e4f5",
  ice: "#b892f0",
  prob: "#76b8d8",
  wind: "#4fc0a2",
  gust: "rgba(79, 192, 162, 0.4)",
  cloud: "rgba(154, 167, 180, 0.4)",
  uv: "#efb23f",
};

export const LIGHT: Palette = {
  bg: "#f8f9fa",
  fg: "#1c2733",
  sub: "#5d6c7b",
  grid: "rgba(93, 108, 123, 0.25)",
  night: "rgba(60, 100, 190, 0.08)",
  now: "#a87d0a",
  temp: "#cf4030",
  appTemp: "rgba(207, 64, 48, 0.55)",
  band: "#cf4030",
  hiLo: "#41505f",
  rain: "#2474d6",
  snow: "#5b7f9e",
  ice: "#7d52c9",
  prob: "#3d89ab",
  wind: "#188a6e",
  gust: "rgba(24, 138, 110, 0.4)",
  cloud: "rgba(110, 124, 138, 0.4)",
  uv: "#c07f10",
};

export interface ViewOptions {
  nowSec: number;
  axis: TimeAxis;
  units: Units;
  palette: Palette;
  hoverSec: number | null;
}

interface Pt {
  x: number;
  y: number;
  w: number;
}

export const UI_FONT = "system-ui, -apple-system, sans-serif";

const AXIS_H = 40;
const TOP_PAD = 6;
const BAND_PAD = 5;

type Ctx = CanvasRenderingContext2D;

function quantizeWeight(w: number): number {
  return Math.round(w * 8) / 8;
}

/** Trace pts[i0..i1) as a smooth open curve: data points become control
 * points of quadratic segments anchored at segment midpoints, so the line
 * bends gently through the valleys instead of kinking at every sample. */
function traceSmooth(ctx: Ctx, pts: readonly { x: number; y: number }[], i0: number, i1: number) {
  ctx.moveTo(pts[i0].x, pts[i0].y);
  if (i1 - i0 < 3) {
    for (let i = i0 + 1; i < i1; i++) ctx.lineTo(pts[i].x, pts[i].y);
    return;
  }
  for (let i = i0 + 1; i < i1 - 1; i++) {
    const midX = (pts[i].x + pts[i + 1].x) / 2;
    const midY = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
  }
  ctx.lineTo(pts[i1 - 1].x, pts[i1 - 1].y);
}

/** Stroke a polyline whose per-vertex weight w controls alpha. Vertices are
 * grouped into weight buckets so each stroke call carries one alpha value. */
function strokeWeighted(ctx: Ctx, pts: Pt[], style: string, width: number, dash?: number[]) {
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (dash) ctx.setLineDash(dash);
  let i = 0;
  const n = pts.length;
  while (i < n) {
    const bucket = quantizeWeight(pts[i].w);
    if (bucket <= 0.05) {
      i++;
      continue;
    }
    ctx.globalAlpha = bucket;
    ctx.beginPath();
    let j = i + 1;
    while (j < n && quantizeWeight(pts[j].w) === bucket) j++;
    traceSmooth(ctx, pts, i, j);
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

  const bandsTop = TOP_PAD;
  const axisTop = cssH - AXIS_H;
  const bandsH = Math.max(220, axisTop - bandsTop);
  const precipBand = { y0: bandsTop, y1: bandsTop + bandsH * 0.16 };
  const tempBand = { y0: precipBand.y1 + 4, y1: precipBand.y1 + 4 + bandsH * 0.4 };
  const windBand = { y0: tempBand.y1 + 4, y1: tempBand.y1 + 4 + bandsH * 0.19 };
  const cloudBand = { y0: windBand.y1 + 4, y1: axisTop };

  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // Night shading and midnight dividers under everything else.
  ctx.fillStyle = palette.night;
  for (const span of model.nights) {
    const x0 = Math.max(gutter, X(span.startSec));
    const x1 = Math.min(right, X(span.endSec));
    if (x1 > x0) ctx.fillRect(x0, bandsTop, x1 - x0, axisTop - bandsTop);
  }
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  for (const g of model.dayGroups) {
    const x = X(g.startSec);
    if (x > gutter + 2 && x < right - 1) {
      ctx.beginPath();
      ctx.moveTo(x, bandsTop);
      ctx.lineTo(x, cssH - 18);
      ctx.stroke();
    }
  }

  const labels = makeGreedyLabels();

  drawPrecip(ctx, model, view, precipBand, X, density, fade, labels);
  drawTemp(ctx, model, view, tempBand, X, density, fade, labels, gutter, right);
  drawWind(ctx, model, view, windBand, X, density, fade, labels);
  drawCloud(ctx, model, view, cloudBand, X, density, fade, labels);

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
  ctx.fillRect(gutter, bandsTop, Xnow - gutter, axisTop - bandsTop);
  ctx.restore();

  drawBandChrome(ctx, palette, gutter, right, [
    { band: precipBand, title: "PRECIP", crest: `${trimNum(model.domains.precipMax)}${view.units === "us" ? "in/h" : "mm/h"}` },
    { band: tempBand, title: "TEMP", crest: trimNum(model.domains.tempHi) },
    { band: windBand, title: "WIND", crest: `${trimNum(model.domains.windMax)}` },
    { band: cloudBand, title: "CLOUD / UV", crest: "" },
  ]);

  drawAxis(ctx, model, view, axisTop, X, density, gutter, right);
  drawNow(ctx, palette, Xnow, bandsTop, cssH);

  if (hoverSec !== null) {
    drawCrosshair(ctx, model, view, hoverSec, X, tempBand, bandsTop, axisTop);
  }
}

function trimNum(v: number): string {
  return Math.abs(v) >= 20 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
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

function drawPrecip(
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
  const base = band.y1 - BAND_PAD;

  // Probability curve across the full band.
  const probPts: Pt[] = [];
  for (const h of model.hours) {
    if (h.precipProbability === undefined) continue;
    probPts.push({
      x: X(h.time),
      y: band.y0 + BAND_PAD + (1 - clamp01(h.precipProbability)) * depth,
      w: 0.75 * fade(h.time),
    });
  }
  strokeWeighted(ctx, probPts, palette.prob, 1);

  // Hourly bars, sqrt-scaled so drizzle and downpour share the axis.
  const pxMax = model.domains.precipMax;
  for (const h of model.hours) {
    const v = h.precipIntensity ?? 0;
    const w = fade(h.time);
    if (v > 0.01) {
      const bw = Math.max(1.2, Math.min(7, density(h.time) * 0.55));
      const hh = Math.max(1, Math.sqrt(Math.min(1, v / pxMax)) * (depth - 2));
      ctx.globalAlpha = 0.9 * w;
      ctx.fillStyle = precipColor(h.precipType, palette);
      ctx.fillRect(X(h.time) - bw / 2, base - hh, bw, hh);
    }
  }
  // Probability labels: nearest to now first, greedy spacing after that.
  labels.reset();
  ctx.font = `10px ${UI_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const byDistance = model.hours
    .slice()
    .sort((a, b) => Math.abs(a.time - view.nowSec) - Math.abs(b.time - view.nowSec));
  for (const h of byDistance) {
    const prob = h.precipProbability ?? 0;
    const w = fade(h.time);
    if (prob < 0.25 || w <= 0.3) continue;
    const text = `${Math.round(prob * 100)}%`;
    const hw = ctx.measureText(text).width / 2 + 5;
    if (!labels.tryPlace(X(h.time), hw)) continue;
    ctx.globalAlpha = Math.min(1, w + 0.2);
    ctx.fillStyle = palette.sub;
    ctx.fillText(text, X(h.time), band.y0 + BAND_PAD - 3);
  }
  ctx.globalAlpha = 1;

  // Minutely bars in the near-future window, where pixels allow them.
  for (const m of model.minutes) {
    const v = m.precipIntensity ?? 0;
    if (v <= 0.01) continue;
    const bw = (density(m.time) / 60) * 0.7;
    if (bw < 1.6) break;
    const hh = Math.max(1, Math.sqrt(Math.min(1, v / pxMax)) * (depth - 2));
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = precipColor(m.precipType, palette);
    ctx.fillRect(X(m.time) - bw / 2, base - hh, bw, hh);
  }
  ctx.globalAlpha = 1;
}

// --- temperature ---

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
  const depth = band.y1 - band.y0 - 2 * BAND_PAD;
  const y = (v: number): number => band.y1 - BAND_PAD - ((v - tempLo) / (tempHi - tempLo)) * depth;

  // Daily min/max band: one trapezoid per day, alpha crossfaded against the
  // hourly line via pixel density. Drawn first so lines sit on top.
  for (const g of model.dayGroups) {
    const hi = g.day.temperatureHigh ?? g.day.temperatureMax;
    const lo = g.day.temperatureLow ?? g.day.temperatureMin;
    if (hi === undefined || lo === undefined) continue;
    const mid = (g.startSec + g.endSec) / 2;
    const lineW = lineWeight(density(mid));
    const bandAlpha = (1 - lineW) * fade(mid) * 0.32;
    if (bandAlpha < 0.02) continue;
    const x0 = Math.max(gutter, X(g.startSec));
    const x1 = Math.min(right, X(g.endSec));
    if (x1 - x0 < 2) continue;
    ctx.globalAlpha = bandAlpha;
    ctx.fillStyle = palette.band;
    ctx.beginPath();
    ctx.moveTo(x0, y(hi));
    ctx.lineTo(x1, y(hi));
    ctx.lineTo(x1, y(lo));
    ctx.lineTo(x0, y(lo));
    ctx.closePath();
    ctx.fill();
  }

  const linePts: Pt[] = [];
  const appPts: Pt[] = [];
  for (const h of model.hours) {
    const w = lineWeight(density(h.time)) * fade(h.time);
    if (h.temperature !== undefined) linePts.push({ x: X(h.time), y: y(h.temperature), w });
    if (h.apparentTemperature !== undefined)
      appPts.push({ x: X(h.time), y: y(h.apparentTemperature), w: w * 0.8 });
  }
  // Runs end where a vertex weight collapses, so no chord crosses a faded gap.
  strokeWeighted(ctx, linePts, palette.temp, 2);
  strokeWeighted(ctx, appPts, palette.appTemp, 1, [4, 3]);

  // Gridlines and gutter ticks at nice steps.
  const step = niceStep((tempHi - tempLo) / 4);
  ctx.font = `10px ${UI_FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let v = Math.ceil(tempLo / step) * step; v <= tempHi; v += step) {
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = palette.grid;
    ctx.beginPath();
    ctx.moveTo(gutter, y(v));
    ctx.lineTo(right, y(v));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.sub;
    ctx.fillText(trimNum(v), gutter - 5, y(v));
  }

  // Daily H/L labels where the band dominates.
  labels.reset();
  for (const g of model.dayGroups) {
    const hi = g.day.temperatureHigh ?? g.day.temperatureMax;
    const lo = g.day.temperatureLow ?? g.day.temperatureMin;
    if (hi === undefined || lo === undefined) continue;
    const mid = (g.startSec + g.endSec) / 2;
    const w = (1 - lineWeight(density(mid))) * fade(mid);
    const width = Math.min(right, X(g.endSec)) - Math.max(gutter, X(g.startSec));
    if (w < 0.3 || width < 34) continue;
    const cx = Math.max(gutter + width / 2, Math.min(right - width / 2, X(mid)));
    ctx.font = `11px ${UI_FONT}`;
    ctx.fillStyle = palette.hiLo;
    ctx.textAlign = "center";
    if (labels.tryPlace(cx, 16)) {
      ctx.globalAlpha = Math.min(1, w + 0.25);
      ctx.textBaseline = "bottom";
      ctx.fillText(formatTemp(hi), cx, y(hi) - 2);
      ctx.textBaseline = "top";
      ctx.fillText(formatTemp(lo), cx, y(lo) + 2);
    }
  }
  ctx.globalAlpha = 1;

  // Hourly temperature values and weather icons where dense enough.
  labels.reset();
  const iconRowY = band.y0 + BAND_PAD;
  const dayIconDone = new Set<number>();
  for (const h of model.hours) {
    const d = density(h.time);
    const w = lineWeight(d) * fade(h.time);
    if (d > 24 && h.temperature !== undefined && w > 0.5) {
      const text = formatTemp(h.temperature);
      ctx.font = `10px ${UI_FONT}`;
      const tw = ctx.measureText(text).width / 2 + 5;
      if (labels.tryPlace(X(h.time), tw)) {
        ctx.globalAlpha = Math.min(1, w + 0.25);
        ctx.fillStyle = palette.fg;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(text, X(h.time), y(h.temperature) - 3);
        if (d > 40 && h.icon) {
          drawIcon(ctx, h.icon, X(h.time) - 6, iconRowY, 12);
        }
      }
    }
  }
  ctx.globalAlpha = 1;

  // One icon per compressed day in band regions.
  for (const g of model.dayGroups) {
    const mid = (g.startSec + g.endSec) / 2;
    if (lineWeight(density(mid)) > 0.25 || !g.day.icon) continue;
    const width = Math.min(right, X(g.endSec)) - Math.max(gutter, X(g.startSec));
    if (width < 24) continue;
    if (dayIconDone.has(g.startSec)) continue;
    dayIconDone.add(g.startSec);
    const cx = Math.max(gutter + width / 2, Math.min(right - width / 2, X(mid)));
    ctx.globalAlpha = fade(mid) * 0.9;
    drawIcon(ctx, g.day.icon, cx - 6, iconRowY, 12);
  }
  ctx.globalAlpha = 1;
}

function niceStep(rough: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / mag;
  return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10) * mag;
}

// --- wind -------------------------------------------------------------

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
  const depth = band.y1 - band.y0 - 2 * BAND_PAD;
  const y = (v: number): number =>
    band.y1 - BAND_PAD - (v / model.domains.windMax) * depth;

  const gustPts: Pt[] = [];
  const speedPts: Pt[] = [];
  for (const h of model.hours) {
    const w = fade(h.time);
    if (h.windGust !== undefined) gustPts.push({ x: X(h.time), y: y(h.windGust), w: w * 0.8 });
    if (h.windSpeed !== undefined) speedPts.push({ x: X(h.time), y: y(h.windSpeed), w });
  }
  strokeWeighted(ctx, gustPts, palette.gust, 1);
  strokeWeighted(ctx, speedPts, palette.wind, 1.5);

  // Direction arrows. Bearings are "from"; arrows point "to".
  labels.reset();
  for (const h of model.hours) {
    if (h.windBearing === undefined || h.windSpeed === undefined) continue;
    const d = density(h.time);
    if (d < 12 || !labels.tryPlace(X(h.time), 15)) continue;
    const w = fade(h.time);
    ctx.globalAlpha = w * 0.9;
    ctx.save();
    ctx.translate(X(h.time), y(h.windSpeed));
    ctx.rotate(((h.windBearing + 180) * Math.PI) / 180);
    ctx.fillStyle = palette.wind;
    ctx.beginPath();
    ctx.moveTo(0, -4.5);
    ctx.lineTo(3, 3.5);
    ctx.lineTo(0, 1.8);
    ctx.lineTo(-3, 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
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
  const y = (v: number): number => band.y1 - BAND_PAD - clamp01(v) * depth;
  const yUv = (v: number): number => band.y1 - BAND_PAD - clamp01(v / 11) * depth;

  // Cloud cover as a filled area with a smoothed top edge.
  ctx.lineWidth = 0;
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length < 2) {
      run = [];
      return;
    }
    ctx.beginPath();
    ctx.moveTo(run[0].x, band.y1 - BAND_PAD);
    ctx.lineTo(run[0].x, run[0].y);
    traceSmooth(ctx, run, 0, run.length);
    ctx.lineTo(run[run.length - 1].x, band.y1 - BAND_PAD);
    ctx.closePath();
    ctx.fill();
    run = [];
  };
  for (const h of model.hours) {
    if (h.cloudCover === undefined) {
      flush();
      continue;
    }
    run.push({ x: X(h.time), y: y(h.cloudCover) });
  }
  ctx.fillStyle = palette.cloud;
  ctx.globalAlpha = 0.55;
  flush();
  ctx.globalAlpha = 1;

  const uvPts: Pt[] = [];
  for (const h of model.hours) {
    if (h.uvIndex === undefined) continue;
    uvPts.push({ x: X(h.time), y: yUv(h.uvIndex), w: fade(h.time) * 0.9 });
  }
  strokeWeighted(ctx, uvPts, palette.uv, 1.2);

  labels.reset();
  for (const h of model.hours) {
    if (h.uvIndex === undefined || h.uvIndex < 3) continue;
    if (density(h.time) < 9 || !labels.tryPlace(X(h.time), 10)) continue;
    ctx.globalAlpha = fade(h.time);
    ctx.font = `9px ${UI_FONT}`;
    ctx.fillStyle = palette.uv;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(String(Math.round(h.uvIndex)), X(h.time), yUv(h.uvIndex) - 2);
  }
  ctx.globalAlpha = 1;
}

// --- chrome -------------------------------------------------------------

interface BandChrome {
  band: { y0: number; y1: number };
  title: string;
  crest: string;
}

function drawBandChrome(
  ctx: Ctx,
  palette: Palette,
  gutter: number,
  right: number,
  entries: BandChrome[],
) {
  ctx.font = `9px ${UI_FONT}`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  for (const { band, title, crest } of entries) {
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = palette.grid;
    ctx.beginPath();
    ctx.moveTo(gutter, band.y1 + 2);
    ctx.lineTo(right, band.y1 + 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.sub;
    ctx.fillText(title, 6, band.y0 + 4);
    if (crest) {
      ctx.textAlign = "left";
      ctx.fillText(crest, 6, band.y0 + 16);
      ctx.textAlign = "left";
    }
  }
}

function drawAxis(
  ctx: Ctx,
  model: Prepared,
  view: ViewOptions,
  axisTop: number,
  X: (t: number) => number,
  density: (t: number) => number,
  gutter: number,
  right: number,
) {
  const { palette } = view;
  const dayLabelY = axisTop + 4;
  const hourLabelY = axisTop + 20;

  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (const g of model.dayGroups) {
    const x0 = Math.max(gutter, X(g.startSec));
    const x1 = Math.min(right, X(g.endSec));
    if (x1 - x0 < 44) continue;
    const cx = (x0 + x1) / 2;
    ctx.font = `600 11px ${UI_FONT}`;
    ctx.fillStyle = palette.fg;
    ctx.fillText(g.label, cx, dayLabelY);
  }

  labels: {
    const taken: number[] = [];
    for (const h of model.hours) {
      const d = density(h.time);
      if (d < 9) continue;
      const x = X(h.time);
      if (x < gutter + 4 || x > right - 4) continue;
      const text = formatHour(model.timezone, h.time);
      ctx.font = `10px ${UI_FONT}`;
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
}

function drawNow(ctx: Ctx, palette: Palette, x: number, y0: number, cssH: number) {
  ctx.strokeStyle = palette.now;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, cssH - 18);
  ctx.stroke();
  ctx.font = `10px ${UI_FONT}`;
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
  tempBand: { y0: number; y1: number },
  y0: number,
  y1: number,
) {
  const x = X(hoverSec);
  const { palette } = view;
  ctx.globalAlpha = 0.75;
  ctx.strokeStyle = palette.fg;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
  ctx.setLineDash([]);

  // Interpolated temperature dot where the hourly line is actually drawn.
  const w = lineWeight(view.axis.pxPerHour(hoverSec * 1000));
  if (w > 0.05) {
    let before: HourPoint | undefined;
    let after: HourPoint | undefined;
    for (const h of model.hours) {
      if (h.temperature === undefined) continue;
      if (h.time <= hoverSec) before = h;
      if (h.time >= hoverSec && !after) after = h;
    }
    if (before && after && before !== after) {
      const f = (hoverSec - before.time) / (after.time - before.time);
      const v = (before.temperature as number) + f * ((after.temperature as number) - (before.temperature as number));
      const { tempLo, tempHi } = model.domains;
      const depth = tempBand.y1 - tempBand.y0 - 2 * BAND_PAD;
      const yv = tempBand.y1 - BAND_PAD - ((v - tempLo) / (tempHi - tempLo)) * depth;
      ctx.globalAlpha = w * 0.95;
      ctx.fillStyle = palette.temp;
      ctx.beginPath();
      ctx.arc(x, yv, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
