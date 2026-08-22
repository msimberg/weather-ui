import { createSignal, onMount, Show } from "solid-js";

/** Version/commit/build time of the serving backend, read from /api/health.
 * The chip is decorative: a failed or empty response shows nothing. */
export function BuildInfoChip() {
  const [info, setInfo] = createSignal<{ version: string; commit: string; built: string } | null>(
    null,
  );
  onMount(async () => {
    try {
      const r = await fetch("/api/health");
      if (r.ok) {
        const j = await r.json();
        if (j.version) setInfo(j);
      }
    } catch {
      /* never let the chip break the page */
    }
  });
  return (
    <Show when={info()} keyed>
      {(b) => (
        <span class="buildinfo" title={`built ${b.built}`}>
          v{b.version} ({b.commit})
        </span>
      )}
    </Show>
  );
}
