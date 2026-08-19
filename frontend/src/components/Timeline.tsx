import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { axisRanges, type Prepared } from "../prepare";
import {
  BAND_EXPLAIN,
  BAND_TITLE,
  DARK,
  LIGHT,
  bandLayout,
  renderTimeline,
  type Palette,
} from "../render";
import {
  hoverSec,
  model,
  nowTick,
  resolvedTheme,
  setHoverSec,
  settings,
  setZen,
  status,
  zen,
} from "../state";
import { warpAxis, type TimeAxis } from "../transform";
import { Tooltip } from "./Tooltip";

/** Left label gutter shared between the axis builder and the renderer. */
export function leftGutter(cssW: number): number {
  return Math.max(44, Math.min(64, cssW * 0.075));
}

const RIGHT_PAD = 6;

export function Timeline() {
  let wrapRef!: HTMLDivElement;
  let canvasRef!: HTMLCanvasElement;
  // Width is a signal because the axis depends on it; ResizeObserver feeds it.
  // Width and height are signals because the axis and the band-title
  // overlay both depend on the canvas size; ResizeObserver feeds them.
  const [width, setWidth] = createSignal(1200);
  const [height, setHeight] = createSignal(600);
  const axis = createMemo<TimeAxis | null>(() => {
    if (!model()) return null;
    const w = width();
    const gutter = leftGutter(w);
    const s = settings();
    const { pastMs, futureMs } = axisRanges(s.pastDays);
    const future = Math.min(futureMs, s.futureDays * 86_400_000);
    return warpAxis(
      nowTick() * 1000,
      pastMs,
      future,
      Math.max(50, w - gutter - RIGHT_PAD),
      { fn: s.warpFn, strength: s.warpStrength },
      s.nowShare,
    );
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
      layout: settings().layout,
      cloudViz: settings().cloudViz,
      bandOrder: settings().bandOrder,
      bandRatios: settings().bandRatios,
      compactHeightVh: settings().compactHeightVh,
    });
  });

  // Band-title overlay: vertical labels at each band's left edge, with the
  // band's legend in a native tooltip so the chart itself stays uncluttered.
  const titles = createMemo(() => {
    const s = settings();
    const L = bandLayout(width(), height(), s.layout, s.bandOrder, s.bandRatios);
    return s.bandOrder
      .map((name) => ({ name, rect: L.bands[name], title: BAND_EXPLAIN[name], label: BAND_TITLE[name], gutter: L.gutter, titleW: L.titleW }))
      .filter((t) => t.rect && t.title);
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
    setHoverSec(
      Math.min(Math.max(next, ax.x2t(0) / 1000), (ax.now + ax.futureMs) / 1000),
    );
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
      classList={{ "timeline-wrap": true, zen: zen(), compact: settings().layout === "compact" }}
      style={(() => {
        const s = settings();
        if (s.layout !== "compact") return {};
        return { height: `${Math.round(s.compactHeightVh * 100)}vh`, flex: "0 0 auto" } as Record<string, string>;
      })()}
      tabIndex={0}
      aria-label="Weather timeline. Arrow keys move the crosshair. F toggles zen mode."
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
              left: `${t.gutter - t.titleW - 2}px`,
              top: `${t.rect.y0 + 4}px`,
              height: `${Math.max(12, t.rect.y1 - t.rect.y0 - 8)}px`,
            }}
          >
            {t.label}
          </span>
        )}
      </For>
      <button
        type="button"
        class="focus-btn"
        onClick={() => setZen(!zen())}
        title="Toggle focus mode (f)"
      >
        {zen() ? "exit focus" : "focus"}
      </button>
      <Show when={status() === "loading"}>
        <div class="loadbar" aria-hidden="true" />
      </Show>
      <Show when={hoverSec() !== null && model() !== null && tooltipAnchor()}>
        {(anchor) => (
          <Show when={model()} keyed>
            {(m: Prepared) => (
              <Tooltip model={m} tSec={hoverSec() as number} style={anchor()} />
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}
