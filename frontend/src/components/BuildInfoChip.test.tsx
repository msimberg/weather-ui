// @vitest-environment jsdom
// The footer build-info chip must surface version+commit from /api/health
// once the async fetch resolves, and stay silent when health lacks a version.

import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuildInfoChip } from "./BuildInfoChip";

function healthResponse() {
  return new Response(
    JSON.stringify({ ok: true, version: "9.9.9", commit: "testc0mmit", built: "2030-01-01 00:00Z" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("BuildInfoChip", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders v<version> (<commit>) with build time in the title", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(healthResponse())));
    const root = document.createElement("div");
    const dispose = render(() => BuildInfoChip(), root);

    const chip = await vi.waitFor(
      () => {
        const el = root.querySelector<HTMLElement>(".buildinfo");
        if (!el?.textContent) throw new Error("no chip yet");
        return el;
      },
      { timeout: 2000 },
    );
    expect(chip.textContent).toBe("v9.9.9 (testc0mmit)");
    expect(chip.title).toBe("built 2030-01-01 00:00Z");
    dispose();
  });

  it("stays empty when health has no version field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))),
    );
    const root = document.createElement("div");
    const dispose = render(() => BuildInfoChip(), root);
    // Give the fetch a full roundtrip; nothing should render.
    await new Promise((r) => setTimeout(r, 50));
    expect(root.querySelector(".buildinfo")).toBeNull();
    dispose();
  });

  it("swallows fetch failures and renders nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));
    const root = document.createElement("div");
    const dispose = render(() => BuildInfoChip(), root);
    await new Promise((r) => setTimeout(r, 50));
    expect(root.querySelector(".buildinfo")).toBeNull();
    dispose();
  });
});
