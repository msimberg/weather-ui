import { describe, expect, it } from "vitest";

import {
  lineWeight,
  pastFade,
  warpAxis,
  MIN_PAST_ALPHA,
  DENSITY_LINE_IN,
  DENSITY_LINE_FULL,
  type Warp,
  type WarpFn,
} from "./transform";

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;
const ALL_FNS: WarpFn[] = ["linear", "power", "log", "asinh", "atan"];

function makeAxis(warp: Warp, pastDays = 4, futureDays = 7, width = 1000, share = 0.4) {
  return warpAxis(NOW, pastDays * DAY, futureDays * DAY, width, warp, share);
}

describe("warpAxis", () => {
  it("maps the range endpoints to the canvas edges for every family", () => {
    for (const fn of ALL_FNS) {
      const axis = makeAxis({ fn, strength: 0.6 });
      expect(axis.t2x(NOW - 4 * DAY)).toBeCloseTo(0, 6);
      expect(axis.t2x(NOW + 7 * DAY)).toBeCloseTo(1000, 6);
      expect(axis.t2x(NOW)).toBeCloseTo(axis.cx, 9);
      expect(axis.t2x(NOW - 100 * DAY)).toBe(0);
      expect(axis.t2x(NOW + 100 * DAY)).toBe(1000);
    }
  });

  it("is its own inverse for every family and strength", () => {
    for (const fn of ALL_FNS) {
      for (const strength of [0, 0.35, 0.7, 1]) {
        const axis = makeAxis({ fn, strength });
        for (let i = 1; i < 200; i++) {
          const t = NOW - 4 * DAY + ((i / 200) * (4 + 7)) * DAY;
          expect(Math.abs(axis.x2t(axis.t2x(t)) - t)).toBeLessThan(60_000);
        }
        for (let x = 0; x <= 1000; x += 25) {
          const back = axis.x2t(x);
          if (back === NOW) {
            // float64 epoch-ms cannot represent sub-0.25ms offsets at 1.75e12
            expect(axis.t2x(back)).toBeCloseTo(axis.cx, 6);
          } else {
            expect(Math.abs(axis.t2x(back) - x)).toBeLessThan(0.02);
          }
        }
      }
    }
  });

  it("is monotonically increasing for every family", () => {
    for (const fn of ALL_FNS) {
      const axis = makeAxis({ fn, strength: 0.5 });
      let prev = -Infinity;
      for (let i = 0; i <= 400; i++) {
        const x = axis.t2x(NOW - 4 * DAY + ((i / 400) * (4 + 7)) * DAY);
        expect(x).toBeGreaterThanOrEqual(prev);
        prev = x;
      }
    }
  });

  it("expands near-now and compresses far times when strength > 0", () => {
    for (const fn of ALL_FNS.filter((f) => f !== "linear")) {
      const axis = makeAxis({ fn, strength: 0.6 });
      const near = axis.pxPerHour(NOW + 3_600_000);
      const far = axis.pxPerHour(NOW + 6 * DAY);
      expect(near).toBeGreaterThan(far * 2);
    }
  });

  it("respects linear regardless of strength", () => {
    const axis = makeAxis({ fn: "linear", strength: 1 });
    expect(axis.pxPerHour(NOW + 3_600_000)).toBeCloseTo(
      axis.pxPerHour(NOW + 6 * DAY),
      9,
    );
  });

  it("slides the anchor with nowShare without changing warp shape", () => {
    const left = makeAxis({ fn: "power", strength: 0.5 }, 4, 7, 1000, 0.2);
    const rightA = makeAxis({ fn: "power", strength: 0.5 }, 4, 7, 1000, 0.7);
    expect(left.cx).toBeCloseTo(200, 6);
    expect(rightA.cx).toBeCloseTo(700, 6);
    // Shape check: one hour into the future, density ratio stays the limb's own.
    expect(left.pxPerHour(NOW + DAY)).toBeGreaterThan(left.pxPerHour(NOW + 6 * DAY));
  });
});

describe("pastFade", () => {
  it("is 1 at and after now, and MIN_PAST_ALPHA at the far edge", () => {
    const past = 4 * DAY;
    expect(pastFade(NOW, NOW, past)).toBe(1);
    expect(pastFade(NOW + DAY, NOW, past)).toBe(1);
    expect(pastFade(NOW - past, NOW, past)).toBeCloseTo(MIN_PAST_ALPHA, 9);
    expect(pastFade(NOW - past / 2, NOW, past)).toBeCloseTo(
      (1 + MIN_PAST_ALPHA) / 2,
      9,
    );
  });
});

describe("lineWeight", () => {
  it("crossfades between the density thresholds", () => {
    expect(lineWeight(1)).toBe(0);
    expect(lineWeight(DENSITY_LINE_IN)).toBe(0);
    expect(lineWeight(DENSITY_LINE_FULL)).toBe(1);
    expect(lineWeight(100)).toBe(1);
    expect(lineWeight((DENSITY_LINE_IN + DENSITY_LINE_FULL) / 2)).toBeCloseTo(0.5);
  });
});
