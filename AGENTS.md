# Repository instructions

Conventions for working in this repo. Global rules live in
`~/.config/pi/agent/AGENTS.md`; this file holds only repo-specific ones.

## Stack and layout

- `src/`: Rust 2021 (axum 0.8) backend. One file per provider
  (`pirate.rs`, `openmeteo.rs`, `meteoblue.rs`), `merge.rs` for the
  shared document assembly, `routes.rs` for dispatch, `cache.rs`
  in-memory response cache, `config.rs` for env parsing.
- `frontend/`: Solid.js + TypeScript + Vite. `src/render/` is the
  Canvas2D painter split (palette, layout, paint, bands, axis);
  `src/prepare.ts` transforms API payloads into the render model.
- Contracts: every provider translates to the Dark Sky-shaped document.
  The frontend never branches on provider internals, only on
  `flags.sources` / `meta.warnings`.

## Commands

- Backend: `cargo test`, `cargo build --release`. Format + lint via
  `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`
  (both enforced in CI).
- Frontend in `frontend/`: `npx vitest run`, `npx tsc --noEmit`,
  `npx biome check .` (Biome is the one tool for lint + format; CI uses
  `biome ci`), `npm run build`.
- Local run: `cargo run` serves `frontend/dist`; build the frontend
  first. Port 8087 is the long-running local server.

## Commits and releases

- Conventional Commits (`feat`, `fix`, `chore`, `ci`, `docs`, ...),
  they drive release-please changelogs. Keep the existing
  plain-English subject style inside the type prefix.
- Releases are cut by release-please opening a release PR; merging it
  tags the release, builds musl static binaries (x86_64 + arm64) and a
  multi-arch OCI image to ghcr.io/msimberg/weather-ui.
- ASCII only in code, comments, docs, and commit messages. Use
  `\u00B0`-style escapes for non-ASCII glyphs in UI strings.

## API keys

- `PIRATE_WEATHER_API_KEY`, `METEOBLUE_API_KEY` are optional server-side
  keys (provider without key returns 503). Never print them, never
  commit them; presence/length checks only.
