import { describe, expect, it } from "vitest";

import { formatDayLabel, formatHour, localMidnight } from "./time";

// 2025-09-01 00:30 in Zurich (CEST, UTC+2) = 2025-08-31 22:30 UTC.
const NOWZ = 1_756_679_400;
const TZ_ZH = "Europe/Zurich";
const TZ_NY = "America/New_York";

describe("formatDayLabel", () => {
  it("handles month boundaries", () => {
    const before = NOWZ - 2 * 3600; // 2025-08-31 23:30 local in Zurich
    expect(formatDayLabel(TZ_ZH, NOWZ, NOWZ)).toBe("Today");
    expect(formatDayLabel(TZ_ZH, before, NOWZ)).toBe("Yesterday");
    // New York (EDT) is 6 hours behind: both instants sit on Aug 31 there.
    expect(formatDayLabel(TZ_NY, before, NOWZ)).toBe("Today");
  });

  it("handles year boundaries", () => {
    const newYearsUtc = 1_735_689_600; // 2025-01-01 00:00:00 UTC
    expect(formatDayLabel("UTC", newYearsUtc - 3600, newYearsUtc)).toBe("Yesterday");
    expect(formatDayLabel("UTC", newYearsUtc, newYearsUtc)).toBe("Today");
    expect(formatDayLabel("UTC", newYearsUtc + 26 * 3600, newYearsUtc)).toBe("Tomorrow");
  });
});

describe("localMidnight", () => {
  it("computes the day boundary in a UTC+2 zone", () => {
    // Local midnight of Sep 1 in Zurich is Aug 31 22:00 UTC.
    const midnight = localMidnight(TZ_ZH, NOWZ);
    expect(midnight).toBe(1_756_677_600);
    expect(formatHour(TZ_ZH, midnight)).toBe("0");
    expect(formatHour(TZ_ZH, midnight + 23 * 3600)).toBe("23");
  });

  it("survives a DST transition day", () => {
    // Europe ended DST on 2025-10-26 (03:00 CEST -> 02:00 CET); at local
    // midnight the zone was still UTC+2, so midnight was Oct 25 22:00 UTC.
    const inDay = localMidnight(TZ_ZH, 1_761_472_800); // 2025-10-26 10:00 UTC
    expect(inDay).toBe(1_761_429_600);
    expect(formatHour(TZ_ZH, inDay)).toBe("0");
  });
});
