import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { axisRanges, type Prepared } from "../prepare";
import {
  BAND_EXPLAIN,
  BAND_TITLE,
  DARK,
  LIGHT,
  TITLE_W,
  bandLayout,
  leftGutter,
  RIGHT_PAD,
  renderTimeline,
  type Palette,
} from "../render";
import {
  focus,
  hoverSec,
  model,
  nowTick,
  resolvedTheme,
  setFocus,
  setHoverSec,
  settings,
  status,
} from "../state";
import { warpAxis, type TimeAxis } from "../transform";
import { Tooltip } from "./Tooltip";

export function Timeline() {
  let wrapRef!: HTMLDivElement;
  let canvasRef!: HTMLCanvasElement;
  // Width and height are signals because the axis and the band-title
  // overlay both depend on the canvas size; ResizeObserver feeds them.
  const [width, setWidth] = createSignal(1200);
  const [height, setHeight] = createSignal(600);

  // One coordinate system: leftGutter/RIGHT_PAD here must match the
  // renderer's bandLayout, else the crosshair and labels drift apart.
  const axis = createMemo<TimeAxis | null>(() => {
    const m = model();
    if (!m) return null;
    const w = width();
    const s = settings();
    const { pastMs, futureMs } = axisRanges(s.pastDays);
    const future = Math.min(futureMs, s.futureDays * 86_400_000);
    const axisW = Math.max(50, w - leftGutter(w) - RIGHT_PAD);
    return warpAxis(nowTick() * 1000, pastMs, future, axisW, { fn: s.warpFn, strength: s.warpStrength }, s.nowShare);
  });

  const palette = createMemo<Palette>(() => (resolvedTheme() === "light" ? LIGHT : DARK));

  createEffect(() => {
    const m = model();
    const ax = axis();
    if (!m || !ax || !canvasRef) return;
    renderTimeline(canvasRef, m, {
      nowSec: nowTick(),
      axis: ax,
      units: settings().units,
      palette: palette(),
      hoverSec: hoverSec(),
      bandOrder: settings().bandOrder,
      bandRatios: settings().bandRatios,
    });
  });

  // Band-title overlay: vertical labels at each band's left edge, with the
  // band's legend in a native tooltip so the chart itself stays uncluttered.
  const titles = createMemo(() => {
    const s = settings();
    const L = bandLayout(width(), height(), s.bandOrder, s.bandRatios);
    return s.bandOrder
      .map((name) => ({ name, rect: L.bands[name], title: BAND_EXPLAIN[name], label: BAND_TITLE[name], gutter: L.gutter }))
      .filter((t) => t.rect && t.title);
  });

  // In compact mode the wrap is shorter than the viewport; set its height
  // here (inline, so it tracks the slider immediately) and let the flex
  // column (#root.compact) center the whole stack around it.
  const wrapStyle = createMemo(() => {
    const s = settings();
    if (s.layout !== "compact") return undefined;
    return { height: `${Math.round(s.compactHeightVh * 100)}vh`, flex: "0 0 auto" } as const;
  });

  onMount(() => {
    const ro = new ResizeObserver(() => {
      if (!wrapRef) return;
      setWidth(wrapRef.clientWidth);
      setHeight(wrapRef.clientHeight);
    });
    ro.observe(wrapRef);
    setWidth(wrapRef.clientWidth);
    setHeight(wrapRef.clientHeight);
    onCleanup(() => ro.disconnect());
  });

  function pointerToSec(e: PointerEvent): number | null {
    const ax = axis();
    if (!ax) return null;
    const rect = wrapRef.getBoundingClientRect();
    const x = e.clientX - rect.left - leftGutter(rect.width);
    return ax.x2t(x) / 1000;
  }

  function onPointerMove(e: PointerEvent) {
    setHoverSec(pointerToSec(e));
  }

  function onPointerLeave() {
    setHoverSec(null);
  }

  function onKeyDown(e: KeyboardEvent) {
    const ax = axis();
    if (!ax) return;
    if (e.key === "Escape") {
      setHoverSec(null);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const base = hoverSec() ?? nowTick();
    const step = e.shiftKey ? 86_400 : 3600;
    const next = base + (e.key === "ArrowLeft" ? -step : step);
    setHoverSec(Math.min(Math.max(next, ax.x2t(0) / 1000), (ax.now + ax.futureMs) / 1000));
  }

  const tooltipAnchor = createMemo(() => {
    const ax = axis();
    const t = hoverSec();
    if (!ax || t === null) return null;
    const w = width();
    const x = leftGutter(w) + ax.t2x(t * 1000);
    // Keep the card on screen: flip to the left of the crosshair near edges.
    const flip = x > w - 340;
    return { x: flip ? x - 316 : x + 16, y: 60 };
  });

  return (
    <div
      ref={wrapRef}
      classList={{ "timeline-wrap": true, compact: settings().layout === "compact" }}
      style={wrapStyle()}
      tabIndex={0}
      role="application"
      aria-label="Weather timeline. Arrow keys move the crosshair. F toggles focus mode."
      onPointerMove={onPointerMove}
      onPointerDown={onPointerMove}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvasRef} />
      <For each={titles()}>
        {(t) => (
          <span
            class="band-title"
            title={t.title}
            style={{
              left: `${t.gutter - TITLE_W - 2}px`,
              top: `${t.rect.y0 + 4}px`,
              height: `${Math.max(12, t.rect.y1 - t.rect.y0 - 8)}px`,
            }}
          >
            {t.label}
          </span>
        )}
      </For>
      <button type="button" class="focus-btn" onClick={() => setFocus(!focus())} title="Toggle focus mode (f)">
        {focus() ? "exit focus" : "focus"}
      </button>
      <Show when={status() === "loading"}>
        <div class="loadbar" aria-hidden="true" />
      </Show>
      <Show when={hoverSec() !== null && model() !== null && tooltipAnchor()}>
        {(anchor) => (
          <Show when={model()} keyed>
            {(m: Prepared) => <Tooltip model={m} tSec={hoverSec() as number} style={anchor()} />}
          </Show>
        )}
      </Show>
    </div>
  );
}
