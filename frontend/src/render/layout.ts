// Band geometry for the timeline canvas. This module owns every horizontal
// pixel constant so the axis builder (Timeline.tsx), the renderer, the band
// titles, and the pointer mapping all agree on one coordinate system.

/** Bare room for band-title text: 11px semibold mono glyphs. */
export const TITLE_W = 12;
/** Right breathing room after the axis, mirroring the small left gutter. */
export const RIGHT_PAD = 6;
/** Band divider gap between stacked band rects. */
export const BAND_GAP = 4;
/** Vertical inset inside each band rect; lines and labels avoid the edges. */
export const BAND_PAD = 4;
/** Canvas rows reserved for the day/hour strips above and below the bands. */
export const AXIS_TOP_PAD = 4;
export const AXIS_TOP_H = 68;
export const AXIS_BOTTOM_H = 68;

/** Left gutter shared by the axis and the renderer. Kept small: titles and
 * the first hour labels overlay the canvas edge instead of reserving room. */
export function leftGutter(cssW: number): number {
  return Math.max(14, Math.min(22, cssW * 0.014));
}

export function canvasRight(cssW: number): number {
  return cssW - RIGHT_PAD;
}

export interface BandRect {
  y0: number;
  y1: number;
}

export interface Layout {
  gutter: number;
  right: number;
  bandsTop: number;
  bandsBottom: number;
  bands: Record<string, BandRect>;
}

/** Vertical placement of the four bands for this canvas size. The bands fill
 * the canvas between the axis strips in both full and compact mode; compact
 * mode is a DOM-level height, not an in-canvas centering (centering bands
 * inside a short canvas was the old behavior and read as empty space). */
export function bandLayout(
  cssW: number,
  cssH: number,
  order: string[],
  ratios: Record<string, number>,
): Layout {
  const gutter = leftGutter(cssW);
  const right = canvasRight(cssW);
  const top = AXIS_TOP_PAD + AXIS_TOP_H;
  const bottom = cssH - AXIS_BOTTOM_H;
  const h = bottom - top;
  const bands: Record<string, BandRect> = {};
  let y = top;
  const totalFrac = order.reduce((a, n) => a + (ratios[n] ?? 1), 0) || 1;
  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const bh = (h * (ratios[name] ?? 1)) / totalFrac;
    bands[name] = { y0: y, y1: y + bh - (i < order.length - 1 ? BAND_GAP : 0) };
    y += bh;
  }
  return { gutter, right, bandsTop: top, bandsBottom: bottom, bands };
}
