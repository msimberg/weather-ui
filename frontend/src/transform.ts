// The time axis is a power warp centered on "now": x = cx +/- span*(|dt|/range)^power.
// With power < 1 the near term expands and the far term compresses, smoothly,
// in both directions. power = 1 is linear. The axis is exactly invertible so a
// pointer position can be mapped back to a timestamp for the crosshair.

export interface TimeAxis {
  /** unix milliseconds -> css pixels, clamped to [0, width] */
  t2x(tMs: number): number;
  /** css pixels -> unix milliseconds, clamped to the range */
  x2t(x: number): number;
  /** |dx/dt| at tMs, in px per hour; Infinity exactly at now for power < 1 */
  pxPerHour(tMs: number): number;
  now: number;
  pastMs: number;
  futureMs: number;
  width: number;
  power: number;
  /** pixel position of t == now */
  cx: number;
}

export const MIN_POWER = 0.15;

const MS_PER_HOUR = 3_600_000;

export function powerAxis(
  now: number,
  pastMs: number,
  futureMs: number,
  width: number,
  power: number,
): TimeAxis {
  const p = Math.min(1, Math.max(MIN_POWER, power));
  // Split the width so the two sides compress symmetrically: each side gets
  // its warped share of the total.
  const pastShare = Math.pow(pastMs, p);
  const futureShare = Math.pow(futureMs, p);
  const cx = (width * pastShare) / (pastShare + futureShare);

  function t2x(tMs: number): number {
    const dt = tMs - now;
    if (dt < 0) {
      const u = Math.min(1, -dt / pastMs);
      return cx - cx * Math.pow(u, p);
    }
    const u = Math.min(1, dt / futureMs);
    return cx + (width - cx) * Math.pow(u, p);
  }

  function x2t(x: number): number {
    if (x < cx) {
      const u = Math.min(1, Math.max(0, (cx - x) / cx));
      return now - Math.pow(u, 1 / p) * pastMs;
    }
    const u = Math.min(1, Math.max(0, (x - cx) / (width - cx)));
    return now + Math.pow(u, 1 / p) * futureMs;
  }

  function pxPerHour(tMs: number): number {
    const dt = tMs - now;
    const span = dt < 0 ? cx : width - cx;
    const range = dt < 0 ? pastMs : futureMs;
    const u = Math.min(1, Math.abs(dt) / range);
    if (u === 0) {
      return p < 1 ? Infinity : (span / range) * MS_PER_HOUR;
    }
    return ((span * p * Math.pow(u, p - 1)) / range) * MS_PER_HOUR;
  }

  return { t2x, x2t, pxPerHour, now, pastMs, futureMs, width, power: p, cx };
}

/** Multiplicative fade for past data: 1 at now, MIN_PAST_ALPHA at the far edge. */
export const MIN_PAST_ALPHA = 0.45;

export function pastFade(tMs: number, now: number, pastMs: number): number {
  if (tMs >= now || pastMs <= 0) return 1;
  const u = Math.min(1, (now - tMs) / pastMs);
  return 1 - (1 - MIN_PAST_ALPHA) * u;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Local detail weight derived from pixel density. Below BAND_PX_ONLY the
 * hourly line is invisible (daily band only); above LINE_PX_FULL it is fully
 * drawn. In between the two are crossfaded. Densities are in px per hour.
 */
export const DENSITY_LINE_IN = 2.2;
export const DENSITY_LINE_FULL = 7;

export function lineWeight(pxPerHour: number): number {
  return clamp01(
    (pxPerHour - DENSITY_LINE_IN) / (DENSITY_LINE_FULL - DENSITY_LINE_IN),
  );
}
