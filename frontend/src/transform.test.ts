import { describe, expect, it } from "vitest";

import {
  lineWeight,
  MIN_POWER,
  pastFade,
  powerAxis,
  MIN_PAST_ALPHA,
  DENSITY_LINE_IN,
  DENSITY_LINE_FULL,
} from "./transform";

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

function makeAxis(power: number, pastDays = 4, futureDays = 7, width = 1000) {
  return powerAxis(NOW, pastDays * DAY, futureDays * DAY, width, power);
}

describe("powerAxis", () => {
  it("maps the range endpoints to the canvas edges", () => {
    const axis = makeAxis(0.4);
    expect(axis.t2x(NOW - 4 * DAY)).toBeCloseTo(0, 6);
    expect(axis.t2x(NOW + 7 * DAY)).toBeCloseTo(1000, 6);
    expect(axis.t2x(NOW)).toBeCloseTo(axis.cx, 9);
  });

  it("clamps outside the range", () => {
    const axis = makeAxis(0.4);
    expect(axis.t2x(NOW - 100 * DAY)).toBe(0);
    expect(axis.t2x(NOW + 100 * DAY)).toBe(1000);
  });

  it("is its own inverse", () => {
    for (const power of [MIN_POWER, 0.35, 0.7, 1]) {
      const axis = makeAxis(power);
      for (let i = 0; i <= 200; i++) {
        const t = NOW - 4 * DAY + ((i / 200) * (4 + 7)) * DAY;
        expect(axis.x2t(axis.t2x(t))).toBeCloseTo(t, -2);
      }
      for (let x = 0; x <= 1000; x += 25) {
        // Near "now" the warp derivative diverges, and at 1.75e12 epoch-ms an
        // offset under ~0.25 ms rounds to exactly now in float64; both effects
        // are sub-pixel in practice, so assert an absolute 0.01 px bound.
        const rt = axis.t2x(axis.x2t(x));
        if (axis.x2t(x) === NOW) {
          expect(rt).toBe(axis.cx);
        } else {
          expect(Math.abs(rt - x)).toBeLessThan(0.01);
        }
      }
    }
  });

  it("is monotonically increasing", () => {
    const axis = makeAxis(0.3);
    let prev = -Infinity;
    for (let i = 0; i <= 400; i++) {
      const x = axis.t2x(NOW - 4 * DAY + ((i / 400) * (4 + 7)) * DAY);
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
  });

  it("expands near-now and compresses far times when power < 1", () => {
    const axis = makeAxis(0.3);
    const near = axis.pxPerHour(NOW + 3_600_000);
    const far = axis.pxPerHour(NOW + 6 * DAY);
    expect(near).toBeGreaterThan(far * 10);
    const linear = makeAxis(1);
    expect(linear.pxPerHour(NOW + 3_600_000)).toBeCloseTo(
      linear.pxPerHour(NOW + 6 * DAY),
      9,
    );
  });

  it("gives infinite density exactly at now for power < 1", () => {
    expect(makeAxis(0.5).pxPerHour(NOW)).toBe(Infinity);
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
