// The four data-band painters: precipitation, temperature, wind, cloud/UV.
// Each is called once per frame with its band rect and the shared helpers.

import { formatTemp, windUnit } from "../format";
import type { Prepared } from "../prepare";
import type { HourPoint, Units } from "../types";
import type { Palette } from "./palette";
import { UI_FONT } from "./palette";
import { BAND_PAD, type BandRect } from "./layout";
import {
  bandY,
  clampX,
  hexToRgb,
  interpSeries,
  labelHalo,
  lineFade,
  strokeWeighted,
  traceSmooth,
  type Ctx,
  type GreedyLabels,
  type Pt,
} from "./paint";

/** What a band painter is allowed to know about the view. */
export interface BandEnv {
  palette: Palette;
  units: Units;
  nowSec: number;
}

const FONT_DATA = `10px ${UI_FONT}`;
const FONT_DATA_BOLD = `600 10px ${UI_FONT}`;

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

  strokeWeighted(ctx, probPts, palette.sub, 1.4);

  labels.reset();
  ctx.font = FONT_DATA;
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
  ctx.font = FONT_DATA;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const r of tempRefs(env.units)) {
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
    const f = lineFade(hr.time - env.nowSec) * fade(hr.time);
    if (hr.temperature !== undefined) linePts.push({ x: X(hr.time), y: y(hr.temperature), w: f });
    if (hr.apparentTemperature !== undefined)
      appPts.push({ x: X(hr.time), y: y(hr.apparentTemperature), w: f * 0.85 });
  }
  strokeWeighted(ctx, appPts, palette.sub, 1.4, [5, 4]);
  strokeWeighted(ctx, linePts, palette.temp, 2.4);

  // Daily high/low dots and labels. Marker and number come as one unit, and
  // a day's H and L come as one atomic group: either both dots AND both
  // labels appear, or the day shows neither. A dot whose value is missing
  // reads as a bug, and an H without the neighboring L truncates the
  // envelope information. The smooth hi/lo envelope above still carries the
  // aggregate shape where groups are dropped.
  labels.reset();
  ctx.font = FONT_DATA_BOLD;
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
    ctx.fillText(formatTemp(hi), xh, y(hi) - 3);
    ctx.textBaseline = "top";
    ctx.fillText(formatTemp(lo), xl, y(lo) + 3);
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

  labels.reset();
  for (const hr of model.hours) {
    if (hr.windBearing === undefined || hr.windSpeed === undefined) continue;
    const x = X(hr.time);
    if (x < gutter + 2) continue;
    if (!labels.tryPlace(x, BARB_SPACING / 2)) continue;
    ctx.globalAlpha = Math.min(1, fade(hr.time) * 0.95 + 0.1);
    drawBarb(ctx, x, y(hr.windSpeed), hr.windBearing, toKnots(hr.windSpeed, env.units), palette.wind, palette.bg);
  }
  ctx.globalAlpha = 1;

  // Daily maximum gust: one dot + value per day, at the hour that peaked,
  // placed at the top of the band with a bg halo so it reads over the line.
  // Same gating as the temperature H/L markers: dot and value are atomic,
  // and dense days drop the whole marker (space-gated below).
  labels.reset();
  ctx.font = FONT_DATA_BOLD;
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
    labelHalo(ctx, text, x, yy - 5, palette.bg);
    ctx.fillStyle = palette.sub;
    ctx.fillText(text, x, yy - 5);
  }
  ctx.globalAlpha = 1;
}

// --- cloud / UV -------------------------------------------------------------

// The three altitude lanes (low/mid/high cloud) sit at these fractional
// positions of the band; coverages smear with a wider falloff so the mass
// reads as one continuous gray profile, not three stacked rows.
const LANE_CENTERS = [0.16, 0.5, 0.84] as const;
const LANE_HALF_WIDTH = 0.22;
// Offscreen buffer resolution: one column per 3 px, 40 altitude rows; drawn
// scaled up with smoothing for a single bilinear-blurred mass.
const CLOUD_ROWS = 40;
const CLOUD_COL_STEP = 3;
// Cloud opacity scale. Higher than in previous iterations so density stays
// readable; the past fade still multiplies on top.
const CLOUD_ALPHA = 0.8;
// UV labels skip the low index values where the line is flat against the floor.
const UV_LABEL_MIN = 3;

let cloudBuf: HTMLCanvasElement | null = null;

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

  // All three lanes share one gray; the only thing that varies is the
  // combined coverage, so cloud reads as a single gray mass whose density
  // tracks how much cloud is overhead (not which altitude it is at).
  const [cg, cgr, cgb] = hexToRgb(palette.cloudInk);

  const x0px = Math.ceil(X(model.hours[0].time));
  const x1px = Math.floor(X(model.hours[model.hours.length - 1].time));
  const cw = Math.max(1, x1px - x0px);
  const OW = Math.max(2, Math.ceil(cw / CLOUD_COL_STEP));
  if (!cloudBuf || cloudBuf.width !== OW || cloudBuf.height !== CLOUD_ROWS) {
    cloudBuf = document.createElement("canvas");
    cloudBuf.width = OW;
    cloudBuf.height = CLOUD_ROWS;
  }
  const octx = cloudBuf.getContext("2d");
  if (octx) {
    const img = octx.createImageData(OW, CLOUD_ROWS);
    for (let px = 0; px < OW; px++) {
      const cx = x0px + (px / (OW - 1)) * cw;
      const tSec = tAtX(cx);
      const f = fade(tSec);
      const [cHi, cMid, cLow] = cov(tSec);
      for (let py = 0; py < CLOUD_ROWS; py++) {
        const p = py / (CLOUD_ROWS - 1);
        const wHi = Math.max(0, 1 - Math.abs(p - LANE_CENTERS[0]) / LANE_HALF_WIDTH);
        const wMid = Math.max(0, 1 - Math.abs(p - LANE_CENTERS[1]) / LANE_HALF_WIDTH);
        const wLow = Math.max(0, 1 - Math.abs(p - LANE_CENTERS[2]) / LANE_HALF_WIDTH);
        const sh = wHi * cHi;
        const sm = wMid * cMid;
        const sl = wLow * cLow;
        const a = clamp01local((sh + sm + sl) / (wHi + wMid + wLow || 1) / 100) * CLOUD_ALPHA * f;
        const idx = (py * OW + px) * 4;
        img.data[idx] = cg;
        img.data[idx + 1] = cgr;
        img.data[idx + 2] = cgb;
        img.data[idx + 3] = (a * 255) | 0;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cloudBuf, 0, 0, OW, CLOUD_ROWS, x0px, y0, cw, depth);
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
  ctx.strokeStyle = bg;
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.85;
  path();
  ctx.stroke();
  ctx.strokeStyle = palette.sub;
  ctx.lineWidth = 1.8;
  ctx.globalAlpha = 0.95;
  path();
  ctx.stroke();
  ctx.globalAlpha = 1;

  // One UV max label per day, like the temp H/L and wind max-gust markers:
  // a single value at the day's peak, no dot. The UV plateau usually spans
  // a few midday hours, so the label centers on the whole max run (start of
  // the first max hour to the next value change) rather than a raw sample.
  labels.reset();
  ctx.font = FONT_DATA;
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

function clamp01local(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
