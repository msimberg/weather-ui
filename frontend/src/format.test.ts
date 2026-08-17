import { describe, expect, it } from "vitest";

import { compass, formatTemp, relativeDelta, windUnit } from "./format";

describe("units", () => {
  it("maps unit systems to wind labels", () => {
    expect(windUnit("si")).toBe("m/s");
    expect(windUnit("ca")).toBe("km/h");
    expect(windUnit("us")).toBe("mph");
    expect(windUnit("uk")).toBe("mph");
    expect(windUnit("uk2")).toBe("mph");
  });
});

describe("formatTemp", () => {
  it("rounds and handles missing values", () => {
    expect(formatTemp(12.4)).toBe("12°");
    expect(formatTemp(-0.6)).toBe("-1°");
    expect(formatTemp(undefined)).toBe("-");
    expect(formatTemp(NaN)).toBe("-");
  });
});

describe("compass", () => {
  it("maps bearings to 16-wind directions", () => {
    expect(compass(0)).toBe("N");
    expect(compass(90)).toBe("E");
    expect(compass(225)).toBe("SW");
    expect(compass(359)).toBe("N");
    expect(compass(undefined)).toBe("");
  });
});

describe("relativeDelta", () => {
  it("chooses minutes, hours, or days by magnitude", () => {
    expect(relativeDelta(45 * 60_000)).toBe("in 45min");
    expect(relativeDelta(-45 * 60_000)).toBe("45min ago");
    expect(relativeDelta(3 * 3_600_000)).toBe("in 3h");
    expect(relativeDelta(3.5 * 3_600_000)).toBe("in 3.5h");
    expect(relativeDelta(-30 * 3_600_000)).toBe("30h ago");
    expect(relativeDelta(2.2 * 86_400_000)).toBe("in 2.2d");
    expect(relativeDelta(-2.2 * 86_400_000)).toBe("2.2d ago");
  });
});
