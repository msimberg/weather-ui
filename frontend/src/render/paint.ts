// Shared canvas primitives used by the band painters and the axis overlays.

import { clamp01 } from "../transform";
import type { HourPoint } from "../types";
import { BAND_PAD, type BandRect } from "./layout";

export type Ctx = CanvasRenderingContext2D;

export interface Pt {
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
export function traceSmooth(
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
export function strokeWeighted(ctx: Ctx, pts: Pt[], style: string, width: number, dash?: number[]) {
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

/** Greedy 1-D overlap rejection for labels: reset before each row/layer. */
export interface GreedyLabels {
  reset(): void;
  tryPlace(x: number, halfWidth: number): boolean;
}

export function makeGreedyLabels(): GreedyLabels {
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

/** Map a normalized value to a band Y, padded so nothing hugs the edges. */
export function bandY(band: BandRect, v: number): number {
  const depth = band.y1 - band.y0 - 2 * BAND_PAD;
  return band.y1 - BAND_PAD - clamp01(v) * depth;
}

/** Clamp a horizontal pixel position into the drawable canvas range. */
export function clampX(x: number, gutter: number, right: number): number {
  return x < gutter ? gutter : x > right ? right : x;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Linear interpolation of a per-timestamp series at tSec. */
export function interpSeries(times: number[], vals: number[], tSec: number): number {
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

/** Nearest bracketing interpolation across the hourly series for the crosshair. */
export function interpAt(
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

/** Hourly-line alpha by |t - now|: full near now, light context far away.
 * Window-width-independent so the detail handoff never shifts on resize. */
const LINE_NEAR_SEC = 18 * 3600;
const LINE_FAR_SEC = 54 * 3600;
const LINE_FAR_ALPHA = 0.35;

export function lineFade(dtSec: number): number {
  const a = Math.abs(dtSec);
  if (a <= LINE_NEAR_SEC) return 1;
  if (a >= LINE_FAR_SEC) return LINE_FAR_ALPHA;
  return 1 - ((1 - LINE_FAR_ALPHA) * (a - LINE_NEAR_SEC)) / (LINE_FAR_SEC - LINE_NEAR_SEC);
}

/** bg-colored stroke under text that sits over data (fill the same text in
 * ink right after). Keeps labels legible across rain bars, clouds, lines. */
export function labelHalo(ctx: Ctx, text: string, x: number, y: number, bg: string, maxWidth?: number) {
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = bg;
  ctx.strokeText(text, x, y, maxWidth);
}
