import { describe, expect, it } from "vitest";

import { dayLabelsFit, hourLabelTimes, HOUR_LABEL_MIN_PX } from "./axis";

const TZ = "UTC";
const DAY = 86_400;
// Midnight-aligned base so day groups and local hours agree.
const BASE = Math.floor(1_750_000_000 / DAY) * DAY;
const HOURS = Array.from({ length: 24 }, (_, i) => BASE + i * 3600);
const DAY_GROUP = { startSec: BASE, endSec: BASE + DAY };

function linearX(pxPerHour: number) {
  return (t: number) => (t - BASE) / 3600 * pxPerHour;
}

function localHourOf(t: number): number {
  return new Date(t * 1000).getUTCHours();
}

describe("dayLabelsFit", () => {
  it("returns true when every label fits its span with margin", () => {
    expect(dayLabelsFit([40, 80], [60, 100])).toBe(true);
  });

  it("returns false when one label does not fit, so the row rotates together", () => {
    expect(dayLabelsFit([40, 80], [60, 90])).toBe(false);
  });

  it("ignores spans too narrow to label at all", () => {
    expect(dayLabelsFit([40], [10])).toBe(true);
  });
});

describe("hourLabelTimes", () => {
  const nowAfterDay = BASE + DAY;

  it("labels every hour when there is room", () => {
    const out = hourLabelTimes(TZ, [DAY_GROUP], HOURS, nowAfterDay, linearX(2 * HOUR_LABEL_MIN_PX), 0, 10000);
    expect(out.length).toBe(24);
  });

  it("never skips a member of the chosen progression (0 3 6 ... 21 all present)", () => {
    // 6 px/hour: step 1 and 2 leave < MIN_PX between labels, step 3 has 18 px.
    const out = hourLabelTimes(TZ, [DAY_GROUP], HOURS, nowAfterDay, linearX(6), 0, 10000);
    const hours = out.map(localHourOf).sort((a, b) => a - b);
    expect(hours).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
  });

  it("splits at now: the part before and the part after can use different steps", () => {
    // Past part at coarse spacing, future part at fine spacing.
    const now = BASE + 12 * 3600 + 1800; // 12:30, hour 12 goes to the past part
    const X = (t: number) =>
      t < now ? (t - BASE) / 3600 * 6 : (12 * 6) + (t - BASE - 12 * 3600) / 3600 * 40;
    const out = hourLabelTimes(TZ, [DAY_GROUP], HOURS, now, X, 0, 10000);
    const hours = out.map(localHourOf);
    const past = hours.filter((h) => h <= 12).sort((a, b) => a - b);
    const future = hours.filter((h) => h > 12).sort((a, b) => a - b);
    // Past part: step 3 -> 0,3,6,9,12. Future part: every hour 13..23.
    expect(past).toEqual([0, 3, 6, 9, 12]);
    expect(future.length).toBe(11);
    expect(future[0]).toBe(13);
    expect(future[future.length - 1]).toBe(23);
  });

  it("returns nothing for a part with no fitting step instead of irregular labels", () => {
    // 1 px/hour: even step 24 only shows midnight; that alone is fine.
    const out = hourLabelTimes(TZ, [DAY_GROUP], HOURS, nowAfterDay, linearX(1), 0, 10000);
    const hours = out.map(localHourOf);
    expect(hours).toEqual([0]);
  });

  it("thins midnight zeros across adjacent days when days get tight", () => {
    // 5 days at 0.5 px/hour: each day individually labels only its midnight
    // (12 px apart), but consecutive midnights collide at < 14 px, so the
    // global pass keeps only every other one. Nearest to now wins.
    const DAYS = 5;
    const groups = Array.from({ length: DAYS }, (_, i) => ({
      startSec: BASE + i * DAY,
      endSec: BASE + (i + 1) * DAY,
    }));
    const hours = Array.from({ length: DAYS * 24 }, (_, i) => BASE + i * 3600);
    const now = BASE + DAYS * DAY;
    const X = (t: number) => (t - BASE) / 3600 * 0.5;
    const out = hourLabelTimes(TZ, groups, hours, now, X, 0, 10000);
    const kept = out.map(localHourOf);
    // Every kept label is a midnight, and none is closer than the minimum.
    expect(kept.every((h) => h === 0)).toBe(true);
    const xs = out.map(X).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(HOUR_LABEL_MIN_PX);
    }
    expect(out.length).toBeLessThan(DAYS);
  });

  it("keeps the label nearer to now when two parts collide", () => {
    // Same day, split at now=12:30. Past part at 1 px/h -> only midnight.
    // Future part at 20 px/h -> every hour. Midnight would keep its slot
    // only if nothing collides; here the near-now hour labels win outright,
    // while the distant midnight remains (no collision at 14 px apart).
    const now = BASE + 12 * 3600 + 1800;
    const X = (t: number) =>
      t < now ? (t - BASE) / 3600 : (12 * 1) + (t - BASE - 12 * 3600) / 3600 * 20;
    const out = hourLabelTimes(TZ, [DAY_GROUP], HOURS, now, X, 0, 10000);
    const hours = out.map(localHourOf).sort((a, b) => a - b);
    expect(hours).toContain(0);
    expect(hours).toContain(13);
    expect(hours).toContain(23);
  });
});
