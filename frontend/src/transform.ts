// The time axis is a warped mapping centered on "now": each limb maps its
// time range through a monotonic curve f: [0,1] -> [0,1] with f(0)=0, f(1)=1.
// Curves with f'(0) > f'(1) expand the near term and compress the far term,
// smoothly, like a fisheye/focus+context lens. Every curve carries its
// inverse and derivative so the crosshair can map pixels back to time and the
// renderer can measure local pixel density (px per hour), which drives all
// detail handoffs.

export type WarpFn = "linear" | "power" | "log" | "asinh" | "atan";

export interface Warp {
  fn: WarpFn;
  /** 0 is linear for every family, 1 is the strongest compression. */
  strength: number;
}

export const DEFAULT_WARP: Warp = { fn: "power", strength: 0.7 };

/** 0.44 puts "now" left of center at the default 4-day past / 7-day future. */
export const DEFAULT_NOW_SHARE = 0.44;

interface Curve {
  f(u: number): number;
  inv(v: number): number;
  d(u: number): number;
}

function asinh(x: number): number {
  return Math.log(x + Math.sqrt(x * x + 1));
}

function curveFor(warp: Warp): Curve {
  const s = Math.min(1, Math.max(0, warp.strength));
  switch (warp.fn) {
    case "linear":
      return { f: (u) => u, inv: (v) => v, d: () => 1 };
    case "power": {
      // strength 0 -> exponent 1 (linear), strength 1 -> 0.15.
      const k = 1 - 0.85 * s;
      return { f: (u) => Math.pow(u, k), inv: (v) => Math.pow(v, 1 / k), d: (u) => k * Math.pow(u, k - 1) };
    }
    case "log": {
      const k = 0.01 + 99 * s;
      const c = Math.log(1 + k);
      return {
        f: (u) => Math.log(1 + u * k) / c,
        inv: (v) => (Math.exp(v * c) - 1) / k,
        d: (u) => k / ((1 + u * k) * c),
      };
    }
    case "asinh": {
      const k = 0.01 + 65 * s;
      const c = asinh(k);
      return {
        f: (u) => asinh(u * k) / c,
        inv: (v) => Math.sinh(v * c) / k,
        d: (u) => k / (c * Math.sqrt(1 + u * u * k * k)),
      };
    }
    case "atan": {
      const k = 0.01 + 60 * s;
      const c = Math.atan(k);
      return {
        f: (u) => Math.atan(u * k) / c,
        inv: (v) => Math.tan(v * c) / k,
        d: (u) => k / (c * (1 + u * u * k * k)),
      };
    }
  }
}

export interface TimeAxis {
  /** unix milliseconds -> css pixels, clamped to [0, width] */
  t2x(tMs: number): number;
  /** css pixels -> unix milliseconds, clamped to the range */
  x2t(x: number): number;
  /** |dx/dt| at tMs, in px per hour; Infinity exactly at now for strong warps */
  pxPerHour(tMs: number): number;
  now: number;
  pastMs: number;
  futureMs: number;
  width: number;
  /** pixel position of t == now */
  cx: number;
}

const MS_PER_HOUR = 3_600_000;

/** nowShare is the fraction of the width left of "now". The limbs warp
 * independently, so the share only slides the anchor, never changes shape. */
export function warpAxis(
  now: number,
  pastMs: number,
  futureMs: number,
  width: number,
  warp: Warp,
  nowShare: number,
): TimeAxis {
  const curve = curveFor(warp);
  const share = Math.min(0.8, Math.max(0.1, nowShare));
  const cx = width * share;

  function t2x(tMs: number): number {
    const dt = tMs - now;
    if (dt < 0) {
      const u = Math.min(1, -dt / pastMs);
      return cx - cx * curve.f(u);
    }
    const u = Math.min(1, dt / futureMs);
    return cx + (width - cx) * curve.f(u);
  }

  function x2t(x: number): number {
    if (x < cx) {
      const v = Math.min(1, Math.max(0, (cx - x) / cx));
      return now - curve.inv(v) * pastMs;
    }
    const v = Math.min(1, Math.max(0, (x - cx) / (width - cx)));
    return now + curve.inv(v) * futureMs;
  }

  function pxPerHour(tMs: number): number {
    const dt = tMs - now;
    const span = dt < 0 ? cx : width - cx;
    const range = dt < 0 ? pastMs : futureMs;
    const u = Math.min(1, Math.abs(dt) / range);
    if (u === 0) {
      const d0 = curve.d(0);
      return d0 === Infinity ? Infinity : (span * d0) / range * MS_PER_HOUR;
    }
    return ((span * curve.d(u)) / range) * MS_PER_HOUR;
  }

  return { t2x, x2t, pxPerHour, now, pastMs, futureMs, width, cx };
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
 * Local detail weight derived from pixel density. Below DENSITY_LINE_IN the
 * hourly line is invisible (daily band only); above DENSITY_LINE_FULL it is
 * fully drawn. In between the two are crossfaded. Densities are in px per hour.
 */
export const DENSITY_LINE_IN = 2.2;
export const DENSITY_LINE_FULL = 7;

export function lineWeight(pxPerHour: number): number {
  return clamp01(
    (pxPerHour - DENSITY_LINE_IN) / (DENSITY_LINE_FULL - DENSITY_LINE_IN),
  );
}
