// Axis and overlay painters: day labels, hour labels, midnight/noon ticks,
// the "now" marker, current-day hour gridlines, and the hover crosshair.

import type { DayGroup, Prepared } from "../prepare";
import { formatHour, localHour } from "../time";
import type { BandRect, Layout } from "./layout";
import { bandY, type Ctx, interpAt, labelHalo } from "./paint";
import { type Palette, uiFont } from "./palette";

// --- constants --------------------------------------------------------------

const dayFont = (bold: boolean) => uiFont(bold ? 700 : 600, 11);
const hourFont = (bold: boolean) => uiFont(bold ? 500 : 400, 11);
const nowFont = (bold: boolean) => uiFont(bold ? 700 : 600, 10);

// Distance from the band edge to each label baseline. Day labels sit outside
// (farther from the bands) the hour labels, on both ends.
const DAY_ROW_OFFSET = 24;
const HOUR_ROW_OFFSET = 10;

// A rotated day label is 40-50px long; it must stay inside the 68px strips.
const DAY_ROTATE_ANGLE = 1.1;
// "don't get quite to the full width": horizontal air on both sides of a
// centered day label. Below this room the row rotates instead.
const DAY_MARGIN = 6;
// Day spans narrower than this get no label at all (nothing meaningful fits).
const DAY_MIN_SPAN = 14;

const TICK_SHORT = 4; // hour ticks and the noon tick
const TICK_LONG = 8; // midnight tick

// Minimum center-to-center px between hour labels. At ~7px per 11px mono
// glyph, two "12"-shaped labels need ~14px apart to stay legible.
export const HOUR_LABEL_MIN_PX = 14;

// Candidate steps. Each picks an arithmetic progression of local hours
// (multiples of the step), so a chosen step always shows a complete,
// regular sequence like 0 3 6 9 ... 21 with nothing skipped.
export const HOUR_STEPS = [1, 2, 3, 6, 12, 24] as const;

// --- day labels ------------------------------------------------------

/** True (= stay horizontal) when at least half of the labelable days can
/** Per-day rotation decision. Rotation follows a limb-wise frontier: starting
 * from "today" (widest, at the warp anchor) each limb stays horizontal until
 * a day cannot hold its label; from that day outward every further day of the
 * limb rotates. The row can therefore be a mix -- horizontal near-now days,
 * rotated wings -- which matches how the fisheye compresses monotonically away
 * from now. Slivers narrower than DAY_MIN_SPAN are never drawn and never open
 * the frontier. If the center day itself cannot fit, everything rotates.
 * Pure for unit tests; the caller measures widths with the day font. */
export function dayLabelsRotate(
  labelWidths: number[],
  spanWidths: number[],
  nowIndex: number,
): boolean[] {
  const rotate = new Array<boolean>(labelWidths.length).fill(false);
  const fails = (i: number) =>
    spanWidths[i] >= DAY_MIN_SPAN && labelWidths[i] + 2 * DAY_MARGIN > spanWidths[i];
  if (fails(nowIndex)) return rotate.fill(true);
  let open = false;
  for (let i = nowIndex - 1; i >= 0; i--) {
    if (fails(i)) open = true;
    rotate[i] = open;
  }
  open = false;
  for (let i = nowIndex + 1; i < rotate.length; i++) {
    if (fails(i)) open = true;
    rotate[i] = open;
  }
  return rotate;
}

/** One-day label decided for the rotated row: "Today" stays a word (it is
 * prominently centered under the now line); other days use the short form
 * so the long "Yesterday" never pokes through the axis strip. */
function rotatedDayLabel(g: DayGroup): string {
  return g.label === "Today" ? "Today" : g.short;
}

function drawDayRow(
  ctx: Ctx,
  palette: Palette,
  model: Prepared,
  L: Layout,
  X: (t: number) => number,
  canvasH: number,
  rotate: boolean[],
  y: number,
  belowBand: boolean,
) {
  ctx.save();
  ctx.beginPath();
  // Clip to this axis row's own strip so a rotated label can never spill
  // into the bands, the header, or the footer.
  const stripY0 = belowBand ? L.bandsBottom : 0;
  const stripY1 = belowBand ? canvasH : L.bandsTop;
  ctx.rect(L.gutter, stripY0, L.right - L.gutter, stripY1 - stripY0);
  ctx.clip();
  ctx.font = dayFont(palette.boldText);
  ctx.fillStyle = palette.fg;

  for (let i = 0; i < model.dayGroups.length; i++) {
    const g = model.dayGroups[i];
    const x0 = Math.max(L.gutter, X(g.startSec));
    const x1 = Math.min(L.right, X(g.endSec));
    const w = x1 - x0;
    if (w < DAY_MIN_SPAN) continue;
    const cx = (x0 + x1) / 2;
    if (rotate[i]) {
      // Emanate from the day midpoint: the text starts there and climbs
      // outward at a steep angle, instead of being centered-then-tilted.
      ctx.save();
      ctx.translate(cx, y);
      ctx.rotate(belowBand ? DAY_ROTATE_ANGLE : -DAY_ROTATE_ANGLE);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(rotatedDayLabel(g), 0, 0);
      ctx.restore();
    } else {
      ctx.textAlign = "center";
      ctx.textBaseline = belowBand ? "top" : "bottom";
      ctx.fillText(g.label, cx, y);
    }
  }
  ctx.restore();
}

// --- hour labels ------------------------------------------------------

/** Selected hour timestamps to label, as one pure function for testability.
 *
 * The axis is split into "leading parts": for every day, the hours before
 * now and the hours from now. Within one part the pixel density is roughly
 * uniform (density only falls off away from now), so a single step -- the
 * finest arithmetic progression 1 | 2 | 3 | 6 | 12 | 24 whose labels keep
 * HOUR_LABEL_MIN_PX of clearance -- is chosen per part. That is what makes
 * the sequence complete inside a day portion (0 3 6 9 12 15 18 21 with no
 * hole at 21) while still letting the far past compress to coarser ticks. */
export function hourLabelTimes(
  tz: string,
  dayGroups: { startSec: number; endSec: number }[],
  hours: number[],
  nowSec: number,
  X: (t: number) => number,
  xmin: number,
  xmax: number,
): number[] {
  // Phase 1: per-day-part complete arithmetic progressions (see pickStep).
  const raw: number[] = [];
  for (const g of dayGroups) {
    const dayHours = hours.filter((t) => t >= g.startSec && t < g.endSec);
    // Two parts per day: before now, and from now. One part may be empty.
    // Splitting at the exact current hour timestamp keeps "now" between
    // labeled hours rather than colliding with one.
    const firstFuture = dayHours.findIndex((t) => t >= nowSec);
    const parts =
      firstFuture < 0
        ? [dayHours]
        : firstFuture === 0
          ? [dayHours]
          : [dayHours.slice(0, firstFuture), dayHours.slice(firstFuture)];
    for (const part of parts) {
      if (part.length === 0) continue;
      const step = pickStep(tz, part, X, xmin, xmax);
      if (step === undefined) continue;
      for (const t of part) if (localHour(tz, t) % step === 0) raw.push(t);
    }
  }

  // Phase 2: global thinning. Progressions are complete within a part, but
  // two adjacent parts (or two dense far days) can land labels arbitrarily
  // close to each other. Resolve collisions by keeping the label nearer to
  // now and dropping the other; in the far field this is what removes the
  // lone midnight "0" per day once days get tight (ticks stay regardless).
  const xNow = X(nowSec);
  const cand = raw
    .map((t) => ({ t, x: X(t) }))
    .filter((c) => c.x >= xmin && c.x <= xmax)
    .sort((a, b) => Math.abs(a.x - xNow) - Math.abs(b.x - xNow) || a.t - b.t);
  const takenX: number[] = [];
  const out: number[] = [];
  for (const c of cand) {
    let collides = false;
    for (const ax of takenX) {
      if (Math.abs(ax - c.x) < HOUR_LABEL_MIN_PX) {
        collides = true;
        break;
      }
    }
    if (collides) continue;
    takenX.push(c.x);
    out.push(c.t);
  }
  return out.sort((a, b) => a - b);
}

/** The finest step that keeps every consecutive pair of its labels at least
 * HOUR_LABEL_MIN_PX apart inside this part, or undefined if nothing fits. */
function pickStep(
  tz: string,
  part: number[],
  X: (t: number) => number,
  xmin: number,
  xmax: number,
): number | undefined {
  for (const step of HOUR_STEPS) {
    const xs = part
      .filter((t) => localHour(tz, t) % step === 0)
      .map(X)
      .filter((x) => x >= xmin - HOUR_LABEL_MIN_PX && x <= xmax + HOUR_LABEL_MIN_PX)
      .sort((a, b) => a - b);
    if (xs.length === 0) continue;
    let ok = true;
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] - xs[i - 1] < HOUR_LABEL_MIN_PX) {
        ok = false;
        break;
      }
    }
    if (ok) return step;
  }
  return undefined;
}

function drawHourRow(
  ctx: Ctx,
  palette: Palette,
  model: Prepared,
  L: Layout,
  X: (t: number) => number,
  labeled: Set<number>,
  canvasH: number,
  y: number,
  belowBand: boolean,
) {
  ctx.save();
  ctx.beginPath();
  const stripY0 = belowBand ? L.bandsBottom : 0;
  const stripY1 = belowBand ? canvasH : L.bandsTop;
  ctx.rect(L.gutter, stripY0, L.right - L.gutter, stripY1 - stripY0);
  ctx.clip();
  ctx.font = hourFont(palette.boldText);
  ctx.textAlign = "center";
  ctx.textBaseline = belowBand ? "top" : "bottom";
  const dir = belowBand ? 1 : -1;
  for (const hr of model.hours) {
    if (!labeled.has(hr.time)) continue;
    const x = X(hr.time);
    if (x < L.gutter + 2 || x > L.right - 2) continue;
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = palette.lineScale;
    ctx.beginPath();
    const t = belowBand ? L.bandsBottom + 2 : L.bandsTop - 2;
    ctx.moveTo(x, t);
    ctx.lineTo(x, t + dir * TICK_SHORT);
    ctx.stroke();
    ctx.fillStyle = palette.sub;
    ctx.fillText(formatHour(model.timezone, hr.time), x, y);
  }
  ctx.restore();
}

// --- public drawers ---------------------------------------------------

export function drawAxis(
  ctx: Ctx,
  palette: Palette,
  model: Prepared,
  L: Layout,
  X: (t: number) => number,
  labeled: Set<number>,
  canvasH: number,
) {
  const { gutter, right } = L;

  // Midnight (long) and noon (short) ticks anchoring each day on both strips.
  ctx.strokeStyle = palette.sub;
  ctx.lineWidth = palette.lineScale;
  for (const g of model.dayGroups) {
    const x0 = X(g.startSec);
    const xn = X((g.startSec + g.endSec) / 2);
    for (const [x, len] of [
      [x0, TICK_LONG],
      [xn, TICK_SHORT],
    ] as const) {
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

  // Day labels: limb-wise rotation frontier (see dayLabelsRotate).
  ctx.font = dayFont(palette.boldText);
  const visWidths = model.dayGroups.map(
    (g) => Math.min(right, X(g.endSec)) - Math.max(gutter, X(g.startSec)),
  );
  const labelWidths = model.dayGroups.map((g) => ctx.measureText(g.label).width);
  const nowIndex = model.dayGroups.findIndex((g) => g.label === "Today");
  const rotate = dayLabelsRotate(labelWidths, visWidths, nowIndex < 0 ? 0 : nowIndex);
  const topDayY = L.bandsTop - DAY_ROW_OFFSET;
  const bottomDayY = L.bandsBottom + DAY_ROW_OFFSET;
  drawDayRow(ctx, palette, model, L, X, canvasH, rotate, topDayY, false);
  drawDayRow(ctx, palette, model, L, X, canvasH, rotate, bottomDayY, true);

  // Hour labels: uniform step per leading part (see hourLabelTimes).
  const topHourY = L.bandsTop - HOUR_ROW_OFFSET;
  const bottomHourY = L.bandsBottom + HOUR_ROW_OFFSET;
  drawHourRow(ctx, palette, model, L, X, labeled, canvasH, topHourY, false);
  drawHourRow(ctx, palette, model, L, X, labeled, canvasH, bottomHourY, true);
}

/** Faint dashed vertical lines at each labeled hour, only within the current
 * day, so the near-now region reads against a soft hourly grid. Matches the
 * hour-label step by construction (same labeled set). */
export function drawCurrentDayHours(
  ctx: Ctx,
  palette: Palette,
  model: Prepared,
  L: Layout,
  X: (t: number) => number,
  nowSec: number,
  labeled: Set<number>,
) {
  const today = model.dayGroups.find((g) => g.startSec <= nowSec && nowSec < g.endSec);
  if (!today) return;
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = palette.lineScale;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([2, 4]);
  for (const hr of model.hours) {
    if (hr.time < today.startSec || hr.time >= today.endSec) continue;
    if (!labeled.has(hr.time)) continue;
    const x = X(hr.time);
    if (x < L.gutter || x > L.right) continue;
    ctx.beginPath();
    ctx.moveTo(x, L.bandsTop);
    ctx.lineTo(x, L.bandsBottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export function drawNow(ctx: Ctx, palette: Palette, x: number, top: number, bottom: number) {
  ctx.strokeStyle = palette.now;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.6 * palette.lineScale;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // "now" flag centered on the line, just inside the top of the band stack
  // (never collides with the hour/day label rows, which live above the
  // bands), with a bg halo so it stays legible over any band content.
  ctx.font = nowFont(palette.boldText);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  labelHalo(ctx, "now", x, top + 2, palette.bg);
  ctx.fillStyle = palette.now;
  ctx.fillText("now", x, top + 2);
}

export function drawCrosshair(
  ctx: Ctx,
  model: Prepared,
  palette: Palette,
  hoverSec: number,
  X: (t: number) => number,
  bands: Record<string, BandRect>,
) {
  const x = X(hoverSec);
  const top = Math.min(...Object.values(bands).map((b) => b.y0));
  const bottom = Math.max(...Object.values(bands).map((b) => b.y1));
  ctx.globalAlpha = 0.65;
  ctx.strokeStyle = palette.fg;
  ctx.lineWidth = palette.lineScale;
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

  const { tempLo, tempHi } = model.domains;
  const tb = bands.temp;
  if (tb) {
    const depth = tb.y1 - tb.y0 - 2 * 4;
    const yTemp = (v: number) => tb.y1 - 4 - ((v - tempLo) / (tempHi - tempLo)) * depth;
    dot(
      interpAt(model.hours, hoverSec, (h) => h.temperature),
      yTemp,
      palette.temp,
      3.5,
    );
  }
  const wb = bands.wind;
  if (wb) {
    dot(
      interpAt(model.hours, hoverSec, (h) => h.windSpeed),
      (v) => bandY(wb, v / model.domains.windMax),
      palette.wind,
      3,
    );
  }
  const cb = bands.cloud;
  if (cb) {
    dot(
      interpAt(model.hours, hoverSec, (h) => h.uvIndex),
      (v) => bandY(cb, v / 11),
      palette.sub,
      2.5,
    );
  }
  const pb = bands.precip;
  if (pb) {
    dot(
      interpAt(model.hours, hoverSec, (h) => h.precipProbability),
      (v) => bandY(pb, v),
      palette.sub,
      2.5,
    );
  }
  ctx.globalAlpha = 1;
}
