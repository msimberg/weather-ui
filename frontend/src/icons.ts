// Minimal weather icon set drawn directly on a 2d canvas. Names follow the
// Pirate Weather / Dark Sky icon vocabulary; unknown names degrade through
// substring matching to the closest known icon. All icons draw inside a
// size x size box with mid-tone colors readable on light and dark palettes.

const SUN = "#f2b23c";
const MOON = "#c8d3e0";
const CLOUD = "#9aa7b4";
const DROP = "#5aa2f0";
const BRIGHT = "#e8eef4";

type Ctx = CanvasRenderingContext2D;

function cloudPath(ctx: Ctx, size: number, x = 0, y = 0, scale = 1): void {
  const s = size * scale;
  ctx.beginPath();
  ctx.ellipse(x + s * 0.32, y + s * 0.55, s * 0.2, s * 0.16, 0, 0, Math.PI * 2);
  ctx.ellipse(x + s * 0.52, y + s * 0.42, s * 0.24, s * 0.2, 0, 0, Math.PI * 2);
  ctx.ellipse(x + s * 0.72, y + s * 0.55, s * 0.18, s * 0.15, 0, 0, Math.PI * 2);
  ctx.rect(x + s * 0.16, y + s * 0.52, s * 0.68, s * 0.2);
}

function fillCloud(ctx: Ctx, size: number, x = 0, y = 0, scale = 1, color = CLOUD): void {
  cloudPath(ctx, size, x, y, scale);
  ctx.fillStyle = color;
  ctx.fill();
}

function fillSun(ctx: Ctx, size: number, cx: number, cy: number, r: number): void {
  ctx.fillStyle = SUN;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = SUN;
  ctx.lineWidth = Math.max(1, size * 0.07);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r * 1.35), cy + Math.sin(a) * (r * 1.35));
    ctx.lineTo(cx + Math.cos(a) * (r * 1.8), cy + Math.sin(a) * (r * 1.8));
    ctx.stroke();
  }
}

function fillMoon(ctx: Ctx, size: number): void {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.34;
  ctx.fillStyle = MOON;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  // New subpath: without moveTo, arc() links the two circles with a line
  // that would cut through the crescent.
  ctx.moveTo(cx + r * 0.7 + r * 0.85, cy - r * 0.35);
  ctx.arc(cx + r * 0.7, cy - r * 0.35, r * 0.85, 0, Math.PI * 2, true);
  ctx.fill("evenodd");
}

function drops(ctx: Ctx, size: number, count: number, snow: boolean): void {
  ctx.strokeStyle = snow ? BRIGHT : DROP;
  ctx.lineWidth = Math.max(1, size * 0.06);
  for (let i = 0; i < count; i++) {
    const x = size * (0.3 + (i / Math.max(1, count - 1)) * 0.4);
    const y = size * 0.86;
    ctx.beginPath();
    if (snow) {
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI;
        ctx.moveTo(x - Math.cos(a) * size * 0.05, y - Math.sin(a) * size * 0.05);
        ctx.lineTo(x + Math.cos(a) * size * 0.05, y + Math.sin(a) * size * 0.05);
      }
    } else {
      ctx.moveTo(x, y - size * 0.06);
      ctx.lineTo(x - size * 0.03, y + size * 0.07);
    }
    ctx.stroke();
  }
}

function fogLines(ctx: Ctx, size: number): void {
  ctx.strokeStyle = CLOUD;
  ctx.lineWidth = Math.max(1, size * 0.06);
  for (let i = 0; i < 3; i++) {
    const y = size * (0.78 + i * 0.09);
    ctx.beginPath();
    ctx.moveTo(size * 0.2, y);
    ctx.lineTo(size * 0.8, y);
    ctx.stroke();
  }
}

function windLines(ctx: Ctx, size: number): void {
  ctx.strokeStyle = CLOUD;
  ctx.lineWidth = Math.max(1, size * 0.07);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(size * 0.15, size * 0.35);
  ctx.bezierCurveTo(size * 0.6, size * 0.35, size * 0.75, size * 0.32, size * 0.78, size * 0.42);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(size * 0.25, size * 0.55);
  ctx.bezierCurveTo(size * 0.75, size * 0.55, size * 0.8, size * 0.62, size * 0.72, size * 0.68);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(size * 0.15, size * 0.7);
  ctx.lineTo(size * 0.5, size * 0.7);
  ctx.stroke();
}

function bolt(ctx: Ctx, size: number): void {
  ctx.fillStyle = SUN;
  ctx.beginPath();
  ctx.moveTo(size * 0.52, size * 0.55);
  ctx.lineTo(size * 0.38, size * 0.82);
  ctx.lineTo(size * 0.5, size * 0.82);
  ctx.lineTo(size * 0.44, size * 0.98);
  ctx.lineTo(size * 0.62, size * 0.68);
  ctx.lineTo(size * 0.5, size * 0.68);
  ctx.closePath();
  ctx.fill();
}

export function drawIcon(ctx: Ctx, name: string | undefined, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  const n = (name ?? "").toLowerCase();
  const has = (...subs: string[]) => subs.some((s) => n.includes(s));

  if (n === "clear-day" || n === "clear") {
    fillSun(ctx, size, size / 2, size / 2, size * 0.22);
  } else if (n === "clear-night") {
    fillMoon(ctx, size);
  } else if (has("partly-cloudy-day", "mostly-sunny")) {
    fillSun(ctx, size, size * 0.32, size * 0.3, size * 0.14);
    fillCloud(ctx, size, size * 0.08, size * 0.22, 0.85);
  } else if (has("partly-cloudy-night")) {
    ctx.save();
    ctx.translate(size * 0.1, 0);
    ctx.scale(0.5, 0.5);
    fillMoon(ctx, size);
    ctx.restore();
    fillCloud(ctx, size, size * 0.08, size * 0.22, 0.85);
  } else if (has("thunder")) {
    fillCloud(ctx, size, 0, -size * 0.05, 0.9);
    bolt(ctx, size);
  } else if (has("snow", "flurr")) {
    fillCloud(ctx, size, 0, -size * 0.08, 0.85);
    drops(ctx, size, 3, true);
  } else if (has("sleet", "mixed", "freezing", "hail", "ice")) {
    fillCloud(ctx, size, 0, -size * 0.08, 0.85);
    drops(ctx, size, 2, false);
    drops(ctx, size, 1, true);
  } else if (has("rain", "drizzle", "shower", "precip")) {
    fillCloud(ctx, size, 0, -size * 0.08, 0.85);
    drops(ctx, size, 3, false);
  } else if (has("fog", "mist", "haze", "smoke")) {
    fillCloud(ctx, size, 0, -size * 0.12, 0.8);
    fogLines(ctx, size);
  } else if (has("wind", "breez")) {
    windLines(ctx, size);
  } else if (has("cloud", "overcast")) {
    fillCloud(ctx, size, 0, size * 0.05, 0.95);
  } else if (has("tornado")) {
    windLines(ctx, size);
  } else {
    // Unknown icon names should not produce invisible UI; default to cloud.
    if (n) console.debug(`[icons] unknown icon name: ${n}`);
    fillCloud(ctx, size, 0, size * 0.05, 0.95);
  }
  ctx.restore();
}
