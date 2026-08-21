// One neutral ink per theme: fg for data ink, sub for secondary. The light
// theme is near-black on paper, the dark theme near-white on near-black.
// styles.css mirrors these values on --bg/--fg/--grid; keep them in sync.

import type { IconStyle } from "../icons";

export const UI_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export interface Palette {
  bg: string;
  fg: string;
  sub: string;
  grid: string;
  night: string;
  now: string;
  temp: string;
  hiLo: string;
  rain: string;
  snow: string;
  ice: string;
  wind: string;
  cloudInk: string;
  /** Stroke-width multiplier; high contrast draws slightly bolder. */
  lineScale: number;
  /** When true, painters use heavier font weights. */
  boldText: boolean;
}

/** Build a canvas font string for UI_FONT. */
export function uiFont(weight: number, px: number): string {
  return `${weight} ${px}px ${UI_FONT}`;
}

const FG = "#17191d";
const LIGHT_BG = "#faf9f6";

export const LIGHT: Palette = {
  bg: LIGHT_BG,
  fg: FG,
  sub: "#59606a",
  grid: "rgba(23, 25, 29, 0.16)",
  night: "rgba(23, 25, 29, 0.05)",
  now: FG,
  temp: FG,
  hiLo: FG,
  rain: FG,
  snow: "#6b7480",
  ice: "#8b96a3",
  wind: FG,
  cloudInk: FG,
  lineScale: 1,
  boldText: false,
};

const FG_DARK = "#e6e3de";

export const DARK: Palette = {
  bg: "#0e1013",
  fg: FG_DARK,
  sub: "#8a93a0",
  grid: "rgba(230, 227, 222, 0.14)",
  night: "rgba(230, 227, 222, 0.045)",
  now: FG_DARK,
  temp: FG_DARK,
  hiLo: FG_DARK,
  rain: FG_DARK,
  snow: "#f2efeb",
  ice: "#a3adbd",
  wind: FG_DARK,
  cloudInk: FG_DARK,
  lineScale: 1,
  boldText: false,
};

// High-contrast variants: primaries go to true black / true white, other
// shades keep their relationships but gain separation.
export const LIGHT_HC: Palette = {
  bg: "#ffffff",
  fg: "#000000",
  sub: "#33383f",
  grid: "rgba(0, 0, 0, 0.3)",
  night: "rgba(0, 0, 0, 0.1)",
  now: "#000000",
  temp: "#000000",
  hiLo: "#000000",
  rain: "#000000",
  snow: "#33383f",
  ice: "#556068",
  wind: "#000000",
  cloudInk: "#000000",
  lineScale: 1.3,
  boldText: true,
};

export const DARK_HC: Palette = {
  bg: "#000000",
  fg: "#ffffff",
  sub: "#c4ccd8",
  grid: "rgba(255, 255, 255, 0.35)",
  night: "rgba(255, 255, 255, 0.09)",
  now: "#ffffff",
  temp: "#ffffff",
  hiLo: "#ffffff",
  rain: "#ffffff",
  snow: "#ffffff",
  ice: "#d5dce6",
  wind: "#ffffff",
  cloudInk: "#ffffff",
  lineScale: 1.3,
  boldText: true,
};

export function iconStyle(p: Palette): IconStyle {
  return { ink: p.fg, accent: p.fg };
}
