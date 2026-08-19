// The canvas renderer. One pass per frame: night shading, four data bands
// (ordered by settings), then a fade-to-the-past overlay. Detail is driven
// by time distance from "now" rather than pixel density: near now the hourly
// lines dominate and the daily aggregates are hidden; in the far field the
// hourly lines fade to a light context while the daily min/max envelope and
// labeled high/low dots take over. Because the fade is by time, the handoff
// never shifts with window width and never covers "now".
//
// Styling is a quiet scientific chart: a single neutral ink (near-black on
// paper, near-white on near-black), monospace numerals, dashed midnight
// dividers, and ticks at every midnight and noon.

import { type IconStyle } from "./icons";
import { formatTemp, windUnit } from "./format";
import { formatHour, localHour } from "./time";
import { clamp01, MIN_PAST_ALPHA, pastFade, type TimeAxis } from "./transform";
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
  hiLo: string;
  rain: string;
  snow: string;
  ice: string;
  wind: string;
  cloudInk: string;
}

export const LIGHT: Palette = {
  bg: "#faf9f6",
  fg: "#17191d",
  sub: "#59606a",
  grid: "rgba(23, 25, 29, 0.16)",
  night: "rgba(23, 25, 29, 0.05)",
  now: "#17191d",
  temp: "#17191d",
  hiLo: "#17191d",
  rain: "#17191d",
  snow: "#6b7480",
  ice: "#8b96a3",
  wind: "#17191d",
  cloudInk: "#17191d",
};

export const DARK: Palette = {
  bg: "#0e1013",
  fg: "#e6e3de",
  sub: "#8a93a0",
  grid: "rgba(230, 227, 222, 0.14)",
  night: "rgba(230, 227, 222, 0.045)",
  now: "#e6e3de",
  temp: "#e6e3de",
  hiLo: "#e6e3de",
  rain: "#e6e3de",
  snow: "#f2efeb",
  ice: "#a3adbd",
  wind: "#e6e3de",
  cloudInk: "#e6e3de",
};

export function iconStyle(p: Palette): IconStyle {
  return { ink: p.fg, accent: p.fg };
}

export const UI_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export const BAND_ORDER: string[] = ["precip", "cloud", "wind", "temp"];

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
  wind:
    "Line = speed. Thin line = gusts. Barbs point where the wind comes from; feathers mark 5 / 10 / 50 knots.",
  temp:
    "Line = hourly temperature (fades far from now). Dashed = feels-like. Dots = daily high and low with the value reached.",
};

export interface ViewOptions {
  nowSec: number;
  axis: TimeAxis;
  units: Units;
  palette: Palette;
  hoverSec: number | null;
  layout: "full" | "compact";
  cloudViz: "density" | "area";
  bandOrder: string[];
  bandRatios: { precip: number; cloud: number; wind: number; temp: number };
  compactHeightVh: number;
}



const TOP_PAD = 4;
const TOP_AXIS_H = 68;
const BOTTOM_AXIS_H = 68;
const BAND_GAP = 4;
const TITLE_W = 12;

export interface BandRect {
  y0: number;
  y1: number;
}

export interface Layout {
  gutter: number;
  right: number;
  titleW: number;
  bandsTop: number;
  bandsBottom: number;
  bands: Record<string, BandRect>;
  topDayY: number;
  topHourY: number;
  bottomHourY: number;
  bottomDayY: number;
}

export function bandLayout(
  cssW: number,
  cssH: number,
  layout: "full" | "compact",
  order: string[],
  ratios: Record<string, number>,
): Layout {
  // Tiny gutter: the canvas should fill the available width, with the band
  // titles and leftmost hour labels overlaid on top of it.
  const gutter = Math.max(14, Math.min(22, cssW * 0.014));
  const right = cssW - 6;
  let top = TOP_PAD + TOP_AXIS_H;
  let bottom = cssH - BOTTOM_AXIS_H;
  let h = bottom - top;
  if (layout === "compact") {
    const target = Math.max(210, Math.min(cssH * 0.42, h));
    const extra = h - target;
    top += extra / 2;
    h = target;
    bottom = top + h;
  }
  const bands: Record<string, BandRect> = {};
  let y = top;
  const totalFrac = order.reduce((a, n) => a + (ratios[n] ?? 0.2), 0) || 1;
  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const frac = (ratios[name] ?? 0.2) / totalFrac;
    const bh = h * frac;
    const gap = i < order.length - 1 ? BAND_GAP : 0;
    bands[name] = { y0: y, y1: y + bh - gap };
    y += bh;
  }
  return {
    gutter,
    right,
    titleW: TITLE_W,
    bandsTop: top,
    bandsBottom: bottom,
    bands,
    topDayY: top - 24,
    topHourY: top - 10,
    bottomHourY: bottom + 10,
    bottomDayY: bottom + 24,
};
}

type Ctx = CanvasRenderingContext2D;

interface Pt {
  x: number;
  y: number;
  w: number;
}

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
 * through the fade; vertices at weight ~0 end the run there. */
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

/** Hourly line alpha: full near now, fading to a light context far away.
 * Window-width-independent. */
const LINE_NEAR = 18 * 3600;
const LINE_FAR = 54 * 3600;
function lineFade(dtSec: number): number {
  const a = Math.abs(dtSec);
  if (a <= LINE_NEAR) return 1;
  if (a >= LINE_FAR) return 0.35;
  return 1 - (0.65 * (a - LINE_NEAR)) / (LINE_FAR - LINE_NEAR);
}


export function renderTimeline(canvas: HTMLCanvasElement, model: Prepared, view: ViewOptions): void {
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

  const L = bandLayout(cssW, cssH, view.layout, view.bandOrder, view.bandRatios);
  const { gutter, right, bandsTop, bandsBottom } = L;
  const X = (tSec: number): number => gutter + axis.t2x(tSec * 1000);
  /** Inverse of X: pixel position -> time in seconds (for column sampling). */
  const tAtX = (x: number): number => axis.x2t((x - gutter) * 1) / 1000;
  const Xnow = gutter + axis.cx;
  const fade = (tSec: number): number => pastFade(tSec * 1000, axis.now, axis.pastMs);

  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // Night shading and dashed midnight dividers under everything else.
  ctx.fillStyle = palette.night;
  for (const span of model.nights) {
    const x0 = Math.max(gutter, X(span.startSec));
    const x1 = Math.min(right, X(span.endSec));
    if (x1 > x0) ctx.fillRect(x0, bandsTop, x1 - x0, bandsBottom - bandsTop);
  }
  drawDividers(ctx, palette, model, X, gutter, right, bandsTop, bandsBottom);

  const labels = makeGreedyLabels();
  for (const name of view.bandOrder) {
    const band = L.bands[name];
    if (!band) continue;
    if (name === "precip") drawPrecip(ctx, model, view, band, X, fade, labels, gutter, right);
    else if (name === "temp") drawTemp(ctx, model, view, band, X, fade, labels, gutter, right);
    else if (name === "wind") drawWind(ctx, model, view, band, X, fade, labels, gutter, right);
    else if (name === "cloud") drawCloud(ctx, model, view, band, X, tAtX, fade, labels);
  }

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
  ctx.fillRect(gutter, bandsTop, Xnow - gutter, bandsBottom - bandsTop);
  ctx.restore();
  // Faint vertical lines at each displayed hour, only for the current day,
  // so the near-now region reads against a soft hourly grid.
  drawCurrentDayHours(ctx, palette, model, view, X, L, gutter, right);

  drawAxis(ctx, palette, model, L, X, gutter, right, cssH);
  ctx.globalAlpha = 1;
  drawNow(ctx, palette, Xnow, bandsTop, bandsBottom);

  if (hoverSec !== null) drawCrosshair(ctx, model, view, hoverSec, X, L.bands);
}

function drawDividers(
  ctx: Ctx,
  palette: Palette,
  model: Prepared,
  X: (t: number) => number,
  gutter: number,
  right: number,
  top: number,
  bottom: number,
) {
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  for (const g of model.dayGroups) {
    const x = X(g.startSec);
    if (x > gutter + 2 && x < right - 1) {
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

function bandY(band: BandRect, v: number): number {
  const depth = band.y1 - band.y0 - 2 * 4;
  return band.y1 - 4 - clamp01(v) * depth;
}

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
  band: BandRect,
  X: (t: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
  gutter: number,
  right: number,
) {
  const { palette } = view;
  const depth = band.y1 - band.y0 - 8;
  const base = band.y1 - 4;
  const pxMax = model.domains.precipMax;
  const h = (v: number): number => Math.max(1, Math.sqrt(Math.min(1, v / pxMax)) * depth);

  const probPts: Pt[] = [];
  for (const hr of model.hours) {
    if (hr.precipProbability === undefined) continue;
    probPts.push({
      x: X(hr.time),
      y: band.y0 + 4 + (1 - clamp01(hr.precipProbability)) * depth,
      w: 0.75 * fade(hr.time),
    });
  }

  // Contiguous bars: each spans to the midpoint with its neighbours, so
  // there is never a gap (especially on wide windows and the current day).
  const xs = model.hours.map((hr) => X(hr.time));
  const barX = (i: number): [number, number] => {
    const here = xs[i];
    const prev = i > 0 ? xs[i - 1] : 2 * here - xs[i + 1];
    const next = i < xs.length - 1 ? xs[i + 1] : 2 * here - prev;
    const x0 = Math.max(gutter, (prev + here) / 2);
    const x1 = Math.min(right, (here + next) / 2);
    return [x0, Math.max(x0 + 0.5, x1)];
  };
  for (let i = 0; i < model.hours.length; i++) {
    const hr = model.hours[i];
    const v = hr.precipIntensity ?? 0;
    const err = hr.precipIntensityError ?? 0;
    const w = fade(hr.time);
    const [x0, x1] = barX(i);
    const bw = x1 - x0;
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

  strokeWeighted(ctx, probPts, palette.sub, 1.4);

  labels.reset();
  ctx.font = `10px ${UI_FONT}`;
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
    ctx.globalAlpha = Math.min(1, fade(mid) + 0.15);
    const text =
      view.units === "us"
        ? `${accum.toFixed(2)}in`
        : `${(accum * 10).toFixed(accum * 10 < 10 ? 1 : 0)}mm total`;
    // The label sits at the foot of the band, over the rain bars, so it
    // gets a bg-colored stroke outline to stay legible there.
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.bg;
    ctx.strokeText(text, cx, band.y1 - 3, 90);
    ctx.fillStyle = palette.sub;
    ctx.fillText(text, cx, band.y1 - 3, 90);
  }
  ctx.globalAlpha = 1;
}

// --- temperature ----------------------------------------------------------

function tempRefs(units: Units): number[] {
  return units === "us" ? [32, 68] : [0, 20];
}

function drawTemp(
  ctx: Ctx,
  model: Prepared,
  view: ViewOptions,
  band: BandRect,
  X: (t: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
  gutter: number,
  right: number,
) {
  const { palette } = view;
  const { tempLo, tempHi } = model.domains;
  const depth = band.y1 - band.y0 - 8;
  const y = (v: number): number => band.y1 - 4 - ((v - tempLo) / (tempHi - tempLo)) * depth;

  // Faint temperature band everywhere, no min/max line. A single smooth
  // region through daily extreme midpoints, kept very light so the hourly
  // line reads on top of it everywhere.
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

  // Reference lines at 0 and 20 (32 and 68 in US), faint, when in range.
  ctx.font = `10px ${UI_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const r of tempRefs(view.units)) {
    if (r < tempLo || r > tempHi) continue;
    ctx.globalAlpha = 0.34;
    ctx.strokeStyle = palette.sub;
    ctx.lineWidth = 1;
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
    const f = lineFade(hr.time - view.nowSec) * fade(hr.time);
    if (hr.temperature !== undefined) linePts.push({ x: X(hr.time), y: y(hr.temperature), w: f });
    if (hr.apparentTemperature !== undefined)
      appPts.push({ x: X(hr.time), y: y(hr.apparentTemperature), w: f * 0.85 });
  }
  strokeWeighted(ctx, appPts, palette.sub, 1.4, [5, 4]);
  strokeWeighted(ctx, linePts, palette.temp, 2.4);

  // Daily high/low dots and labels, gated only by space. The high label
  // sits at the high point, the low label at the low point (never combined).
  labels.reset();
  ctx.font = `11px ${UI_FONT}`;
  ctx.fillStyle = palette.hiLo;
  for (const g of model.dayGroups) {
    const hi = g.day.temperatureHigh ?? g.day.temperatureMax;
    const lo = g.day.temperatureLow ?? g.day.temperatureMin;
    if (hi === undefined || lo === undefined) continue;
    const ht = g.day.temperatureHighTime ?? (g.startSec + g.endSec) / 2;
    const lt = g.day.temperatureLowTime ?? (g.startSec + g.endSec) / 2;
    const xh = clampX(X(ht), gutter, right);
    const xl = clampX(X(lt), gutter, right);
    const f = Math.min(1, fade((g.startSec + g.endSec) / 2) + 0.15);
    const dayW = Math.abs(X(g.endSec) - X(g.startSec));
    if (dayW > 6) {
      ctx.globalAlpha = f;
      ctx.beginPath();
      ctx.arc(xh, y(hi), 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(xl, y(lo), 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (dayW > 34) {
      ctx.globalAlpha = f;
      ctx.textAlign = "center";
      if (labels.tryPlace(xh, 14)) {
        ctx.textBaseline = "bottom";
        ctx.fillText(formatTemp(hi), xh, y(hi) - 3);
      }
      if (labels.tryPlace(xl, 14)) {
        ctx.textBaseline = "top";
        ctx.fillText(formatTemp(lo), xl, y(lo) + 3);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function clampX(x: number, gutter: number, right: number): number {
  return x < gutter ? gutter : x > right ? right : x;
}

// --- wind -----------------------------------------------------------------

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

/** WMO station-model wind barb with a bg-colored halo so it reads against
 * the speed line. Shaft is 18px; feathers at the tail: pennant 50 kt,
 * long barb 10 kt, short barb 5 kt. */
function drawBarb(ctx: Ctx, x: number, y: number, bearingDeg: number, knots: number, color: string, halo: string) {
  const draw = (lw: number, stroke: string, fill: string | null) => {
    ctx.strokeStyle = stroke;
    ctx.fillStyle = fill ?? stroke;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    const shaftLen = 18;
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.lineTo(0, 6 - shaftLen);
    ctx.stroke();
    let kt = knots;
    let ty = 6 - shaftLen;
    while (kt >= 47.5) {
      ctx.beginPath();
      ctx.moveTo(0, ty);
      ctx.lineTo(-7, ty + 5);
      ctx.lineTo(0, ty + 10);
      ctx.closePath();
      if (fill) ctx.fill();
      ctx.stroke();
      ty += 3;
      kt -= 50;
    }
    while (kt >= 10) {
      ctx.beginPath();
      ctx.moveTo(0, ty);
      ctx.lineTo(-6.5, ty + 5);
      ctx.stroke();
      ty += 4.5;
      kt -= 10;
    }
    if (kt >= 5) {
      ctx.beginPath();
      ctx.moveTo(0, ty);
      ctx.lineTo(-3.5, ty + 2.7);
      ctx.stroke();
    } else if (knots < 2.5) {
      ctx.beginPath();
      ctx.arc(0, -2, 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  };
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((bearingDeg * Math.PI) / 180);
  // Halo: wider, bg-colored stroke under everything.
  draw(4, halo, null);
  // Barb: the ink color, on top.
  draw(2, color, color);
  ctx.restore();
}

function drawWind(
  ctx: Ctx,
  model: Prepared,
  view: ViewOptions,
  band: BandRect,
  X: (t: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
  gutter: number,
  right: number,
) {
  const { palette } = view;
  const y = (v: number): number => bandY(band, v / model.domains.windMax);

  const gustPts: Pt[] = [];
  const speedPts: Pt[] = [];
  for (const hr of model.hours) {
    const f = fade(hr.time);
    if (hr.windGust !== undefined) gustPts.push({ x: X(hr.time), y: y(hr.windGust), w: f * 0.75 });
    if (hr.windSpeed !== undefined) speedPts.push({ x: X(hr.time), y: y(hr.windSpeed), w: f });
  }
  strokeWeighted(ctx, gustPts, palette.sub, 1.4);
  strokeWeighted(ctx, speedPts, palette.wind, 2.4);

  // Barbs at a fixed pixel spacing, so they show on every window width
  // (more on wide windows, fewer on narrow ones, never none) rather than
  // vanishing when the axis is compressed.
  labels.reset();
  const SP = 64;
  for (const hr of model.hours) {
    if (hr.windBearing === undefined || hr.windSpeed === undefined) continue;
    const x = X(hr.time);
    if (x < gutter + 2) continue;
    if (!labels.tryPlace(x, SP / 2)) continue;
    ctx.globalAlpha = Math.min(1, fade(hr.time) * 0.95 + 0.1);
    drawBarb(ctx, x, y(hr.windSpeed), hr.windBearing, toKnots(hr.windSpeed, view.units), palette.wind, palette.bg);
  }
  ctx.globalAlpha = 1;

  // Daily maximum gust: one dot + value per day, at the hour that peaked,
  // placed at the top of the band with a bg halo so it reads over the line.
  labels.reset();
  ctx.font = `600 10px ${UI_FONT}`;
  ctx.textAlign = "center";
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
    const x = clampX(X(bt.time), gutter, right);
    const yy = y(best);
    ctx.globalAlpha = Math.min(1, fade((g.startSec + g.endSec) / 2) + 0.15);
    ctx.fillStyle = palette.bg;
    ctx.beginPath();
    ctx.arc(x, yy, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = palette.sub;
    ctx.beginPath();
    ctx.arc(x, yy, 2.4, 0, Math.PI * 2);
    ctx.fill();
    const text = `${best.toFixed(0)} ${windUnit(view.units)}`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.bg;
    ctx.textBaseline = "bottom";
    ctx.strokeText(text, x, yy - 5);
    ctx.fillStyle = palette.sub;
    ctx.fillText(text, x, yy - 5);
  }
  ctx.globalAlpha = 1;
}

// --- cloud / uv -----------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Linear interpolation of a per-timestamp series at tSec. */
function interpSeries(times: number[], vals: number[], tSec: number): number {
  if (times.length === 0) return 0;
  if (tSec <= times[0]) return vals[0] ?? 0;
  if (tSec >= times[times.length - 1]) return vals[times.length - 1] ?? 0;
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= tSec) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo] || 1;
  const u = (tSec - times[lo]) / span;
  return (vals[lo] ?? 0) * (1 - u) + (vals[hi] ?? 0) * u;
}

const LANE_C = [0.16, 0.5, 0.84] as const;
const LANE_HW = 0.22; // half-width of each lane's vertical falloff

// Reusable offscreen canvas for smooth cloud rendering (sized to the band).
let cloudBuf: HTMLCanvasElement | null = null;
function drawCloud(
  ctx: Ctx,
  model: Prepared,
  view: ViewOptions,
  band: BandRect,
  X: (t: number) => number,
  tAtX: (x: number) => number,
  fade: (t: number) => number,
  labels: GreedyLabels,
) {
  const { palette } = view;
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
  // All three lanes share one gray; the only thing that varies is the
  // combined coverage, so cloud reads as a single gray mass whose density
  // tracks how much cloud is overhead (not which altitude it is at).
  const [cg, cgr, cgb] = hexToRgb(palette.cloudInk);

  // Render cloud to a small offscreen canvas (one column per ~3px, 40
  // altitude rows), then draw it scaled up with image smoothing so the
  // result is a single smooth mass — bilinear interpolation handles the
  // horizontal blend between hours, and a vertical blur pass merges the
  // three lanes into one continuous gray profile. Kept inside [y0, y1].
  const x0px = Math.ceil(X(model.hours[0].time));
  const x1px = Math.floor(X(model.hours[model.hours.length - 1].time));
  const cw = Math.max(1, x1px - x0px);
  const OH = 40;
  const OW = Math.max(2, Math.ceil(cw / 3));
  if (!cloudBuf || cloudBuf.width !== OW || cloudBuf.height !== OH) {
    cloudBuf = document.createElement("canvas");
    cloudBuf.width = OW;
    cloudBuf.height = OH;
  }
  const octx = cloudBuf.getContext("2d");
  if (octx) {
    const img = octx.createImageData(OW, OH);
    for (let px = 0; px < OW; px++) {
      const cx = x0px + (px / (OW - 1)) * cw;
      const tSec = tAtX(cx);
      const f = fade(tSec);
      const [cHi, cMid, cLow] = cov(tSec);
      for (let py = 0; py < OH; py++) {
        const p = py / (OH - 1);
        // Broader falloff so the three lanes blend more vertically.
        const wHi = Math.max(0, 1 - Math.abs(p - LANE_C[0]) / LANE_HW);
        const wMid = Math.max(0, 1 - Math.abs(p - LANE_C[1]) / LANE_HW);
        const wLow = Math.max(0, 1 - Math.abs(p - LANE_C[2]) / LANE_HW);
        const sh = wHi * cHi;
        const sm = wMid * cMid;
        const sl = wLow * cLow;
        // Total coverage (0..1) drives the single-gray alpha; less
        // transparent than before so intensity is easy to read.
        const a = clamp01((sh + sm + sl) / (wHi + wMid + wLow || 1) / 100) * 0.8 * f;
        const idx = (py * OW + px) * 4;
        img.data[idx] = cg;
        img.data[idx + 1] = cgr;
        img.data[idx + 2] = cgb;
        img.data[idx + 3] = (a * 255) | 0;
      }
    }
    octx.putImageData(img, 0, 0);
    // Vertical blur: a short horizontal-line box blur averages neighbouring
    // rows so the altitude lanes merge with no visible seam.
    const tmp = document.createElement("canvas");
    tmp.width = OW;
    tmp.height = OH;
    const tctx = tmp.getContext("2d");
    if (tctx) {
      tctx.drawImage(cloudBuf, 0, 0);
      tctx.filter = "blur(0 1.5px)";
      tctx.drawImage(cloudBuf, 0, 0);
      tctx.filter = "none";
      cloudBuf = tmp;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cloudBuf, 0, 0, OW, OH, x0px, y0, cw, depth);
    ctx.imageSmoothingQuality = "low";
  }
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
    ctx.beginPath();
    ctx.moveTo(uvPts[0].x, uvPts[0].y);
    for (let i = 1; i < uvPts.length; i++) {
      ctx.lineTo(uvPts[i].x, uvPts[i - 1].y);
      ctx.lineTo(uvPts[i].x, uvPts[i].y);
    }
  };
  // Halo: a wider, bg-colored stroke under the line.
  ctx.strokeStyle = bg;
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.85;
  path();
  ctx.stroke();
  // Line: the UV ink, on top.
  ctx.strokeStyle = palette.sub;
  ctx.lineWidth = 1.8;
  ctx.globalAlpha = 0.95;
  path();
  ctx.stroke();
  ctx.globalAlpha = 1;

  // One UV value label per constant-value run, placed in the horizontal
  // middle of the run (so it never sits on a step edge) and just above the
  // line, so it never overlaps the line itself.
  labels.reset();
  ctx.font = `10px ${UI_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  let i = 0;
  while (i < uvPts.length) {
    let j = i + 1;
    while (j < uvPts.length && uvPts[j].v === uvPts[i].v) j++;
    // The horizontal run extends from uvPts[i].x to the next step edge
    // (uvPts[j].x, where the value changes); center the label on that
    // span, not on the points, so it never sits at a step start.
    const xEnd = j < uvPts.length ? uvPts[j].x : uvPts[j - 1].x;
    const cx = (uvPts[i].x + xEnd) / 2;
    const v = uvPts[i].v;
    if (v >= 3 && labels.tryPlace(cx, 8)) {
      const text = String(Math.round(v));
      ctx.globalAlpha = fade(uvPts[i].t);
      // A real bg stroke (halo) so the value reads against the clouds.
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.strokeStyle = bg;
      ctx.strokeText(text, cx, uvY(v) - 2);
      ctx.fillStyle = palette.sub;
      ctx.fillText(text, cx, uvY(v) - 2);
    }
    i = j;
  }
  ctx.globalAlpha = 1;
}
// --- axis -----------------------------------------------------------------

/** Nice-hour step for a given local pixel density (px between neighbours).
 * Dense regions label every hour; as the axis compresses the step grows so
 * labels are always multiples of the step (never irregular) and never crowd. */
function hourStep(px: number): number {
  if (px >= 24) return 1;
  if (px >= 16) return 2;
  if (px >= 12) return 3;
  if (px >= 8) return 6;
  if (px >= 4) return 12;
  return 24;
}

function drawAxis(
  ctx: Ctx,
  palette: Palette,
  model: Prepared,
  L: Layout,
  X: (t: number) => number,
  gutter: number,
  right: number,
  canvasH: number,
) {
  // Day labels, centered in each day's span, at top and bottom. When the
  // span is narrow the label tilts so it still fits and stays associated
  // with its day. Drawing is clipped to the axis area so a rotated label
  // can never spill into the bands, the header, or the footer.
  ctx.font = `600 11px ${UI_FONT}`;
  ctx.fillStyle = palette.fg;
  ctx.textAlign = "center";
  const drawDayRow = (clipY0: number, clipY1: number, y: number, dir: 1 | -1) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(gutter, clipY0, right - gutter, clipY1 - clipY0);
    ctx.clip();
    for (const g of model.dayGroups) {
      const x0 = Math.max(gutter, X(g.startSec));
      const x1 = Math.min(right, X(g.endSec));
      const w = x1 - x0;
      if (w < 14) continue;
      const cx = (x0 + x1) / 2;
      if (w < 48) {
        // Emanate from the day's midpoint: the text starts at the
        // midpoint and radiates outward from the band at a steep angle
        // (top row up, bottom row down), rather than being centered on
        // the midpoint then tilted. textAlign="left" anchors the start
        // of the text at the midpoint; the clip keeps it off the bands.
        ctx.save();
        ctx.translate(cx, y);
        ctx.rotate(dir * 1.1);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(g.label, 0, 0);
        ctx.restore();
      } else {
        ctx.textBaseline = dir > 0 ? "top" : "bottom";
        ctx.fillText(g.label, cx, y);
      }
    }
    ctx.restore();
  };
  drawDayRow(0, L.bandsTop, L.topDayY, -1);
  drawDayRow(L.bandsBottom, canvasH, L.bottomDayY, 1);

  // Hour labels at nice round hours. The step is chosen PER HOUR from the
  // local pixel spacing, so near now (dense) every hour is labelled and in
  // the compressed far field only multiples of 6/12/24 appear — always
  // round, never irregular, and never crowded. A light greedy filter only
  // drops an exact duplicate x.
  const drawHourRow = (clipY0: number, clipY1: number, y: number, dir: 1 | -1) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(gutter, clipY0, right - gutter, clipY1 - clipY0);
    ctx.clip();
    ctx.font = `11px ${UI_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = dir > 0 ? "top" : "bottom";
    let last = -Infinity;
    for (let i = 0; i < model.hours.length; i++) {
      const hr = model.hours[i];
      const x = X(hr.time);
      if (x < gutter + 2 || x > right - 2) continue;
      const pxPrev = i > 0 ? x - X(model.hours[i - 1].time) : Infinity;
      const pxNext = i < model.hours.length - 1 ? X(model.hours[i + 1].time) - x : Infinity;
      const px = Math.min(pxPrev, pxNext);
      if (localHour(model.timezone, hr.time) % hourStep(px) !== 0) continue;
      if (x - last < 20) continue;
      last = x;
      ctx.strokeStyle = palette.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - dir * 2);
      ctx.lineTo(x, y - dir * 6);
      ctx.stroke();
      ctx.fillStyle = palette.sub;
      ctx.fillText(formatHour(model.timezone, hr.time), x, y);
    }
    ctx.restore();
  };
  drawHourRow(0, L.bandsTop, L.topHourY, -1);
  drawHourRow(L.bandsBottom, canvasH, L.bottomHourY, 1);

  // Midnight (long) and noon (short) ticks on both rows.
  ctx.strokeStyle = palette.sub;
  for (const g of model.dayGroups) {
    const xm = X(g.startSec);
    const mid = (g.startSec + g.endSec) / 2;
    const xn = X(mid);
    for (const [x, len] of [[xm, 8], [xn, 4]] as const) {
      if (x < gutter + 1 || x > right - 1) continue;
      ctx.beginPath();
      ctx.moveTo(x, L.bandsTop - 2);
      ctx.lineTo(x, L.bandsTop - 2 - len);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, L.bandsBottom + 2);
      ctx.lineTo(x, L.bandsBottom + 2 + len);
      ctx.stroke();
    }
  }
}

/** Faint vertical lines at each hour that is actually labelled, but only for
 *  the current day, so the near-now region has a soft hourly grid behind it. */
function drawCurrentDayHours(
  ctx: Ctx,
  palette: Palette,
  model: Prepared,
  view: ViewOptions,
  X: (t: number) => number,
  L: Layout,
  gutter: number,
  right: number,
) {
  const now = view.nowSec;
  const today = model.dayGroups.find((g) => g.startSec <= now && now < g.endSec);
  if (!today) return;
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([2, 4]);
  for (let i = 0; i < model.hours.length; i++) {
    const h = model.hours[i];
    if (h.time < today.startSec || h.time >= today.endSec) continue;
    const x = X(h.time);
    if (x < gutter || x > right) continue;
    const pxPrev = i > 0 ? x - X(model.hours[i - 1].time) : Infinity;
    const pxNext = i < model.hours.length - 1 ? X(model.hours[i + 1].time) - x : Infinity;
    if (localHour(model.timezone, h.time) % hourStep(Math.min(pxPrev, pxNext)) !== 0) continue;
    ctx.beginPath();
    ctx.moveTo(x, L.bandsTop);
    ctx.lineTo(x, L.bandsBottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawNow(ctx: Ctx, palette: Palette, x: number, top: number, bottom: number) {
  // Vertical now line through the bands.
  ctx.strokeStyle = palette.now;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // "now" tag at the TOP of the line, just above the bands, with a bg
  // halo so it reads against the chart and never crowds the bottom.
  ctx.font = `600 10px ${UI_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = palette.bg;
  ctx.strokeText("now", x + 4, top - 2);
  ctx.fillStyle = palette.now;
  ctx.fillText("now", x + 4, top - 2);
}

function drawCrosshair(
  ctx: Ctx,
  model: Prepared,
  view: ViewOptions,
  hoverSec: number,
  X: (t: number) => number,
  bands: Record<string, BandRect>,
) {
  const { palette } = view;
  const x = X(hoverSec);
  const top = Math.min(...Object.values(bands).map((b) => b.y0));
  const bottom = Math.max(...Object.values(bands).map((b) => b.y1));
  ctx.globalAlpha = 0.65;
  ctx.strokeStyle = palette.fg;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
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

  const tb = bands.temp;
  const { tempLo, tempHi } = model.domains;
  const tempDepth = tb.y1 - tb.y0 - 8;
  const yTemp = (v: number) => tb.y1 - 4 - ((v - tempLo) / (tempHi - tempLo)) * tempDepth;
  dot(interpAt(model.hours, hoverSec, (h) => h.temperature), yTemp, palette.temp, 3.5);

  const wb = bands.wind;
  dot(interpAt(model.hours, hoverSec, (h) => h.windSpeed), (v) => bandY(wb, v / model.domains.windMax), palette.wind);

  const cb = bands.cloud;
  dot(interpAt(model.hours, hoverSec, (h) => h.uvIndex), (v) => bandY(cb, v / 11), palette.sub, 2.5);

  const pb = bands.precip;
  dot(interpAt(model.hours, hoverSec, (h) => h.precipProbability), (v) => bandY(pb, v), palette.sub, 2.5);

  ctx.globalAlpha = 1;
}
