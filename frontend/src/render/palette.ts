// One neutral ink per theme: fg for data ink, sub for secondary. The light
// theme is near-black on paper, the dark theme near-white on near-black.
// styles.css mirrors these values on --bg/--fg/--grid; keep them in sync.

import { type IconStyle } from "../icons";

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
};

export function iconStyle(p: Palette): IconStyle {
  return { ink: p.fg, accent: p.fg };
}
