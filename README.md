> Human comment: This repo is obviously agent-generated and exists because I
> wanted to explore the "fisheye" visualization for a weather forecast. I
> was bothered by forecasts either giving a good long term view or a good
> short term view, but never both together.

# weather-ui

[![CI](https://github.com/msimberg/weather-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/msimberg/weather-ui/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/msimberg/weather-ui?sort=semver)](https://github.com/msimberg/weather-ui/releases)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](./license)
[![image](https://img.shields.io/badge/image-ghcr.io%2Fmsimberg%2Fweather--ui-informational)](https://github.com/msimberg/weather-ui/pkgs/container/weather-ui)

A weather dashboard built around a single continuous time axis with a
focus+context (fisheye) warp: the hours around "now" are spread out and
shown in full detail, and data compresses smoothly with distance in both
directions. There are no separate hourly/daily/weekly views. One axis,
past days fading into lower detail on the left, forecast days compressing
into daily summary bands on the right.

Data comes from a selectable provider:

- **Open-Meteo** (default): best-match national models, no key, e.g.
  MeteoSwiss ICON-CH at 1-2 km over Switzerland. Free for non-commercial
  use, ~10k calls/day.
- **meteoblue**: their AI-blend model as the backbone (temperature,
  precipitation, wind, UV), with Open-Meteo filling everything the free
  tier lacks (cloud layers, gusts, visibility, sun/moon times, nowcast).
  Needs `METEOBLUE_API_KEY`. Free tier: max 1h resolution, 4 days of
  history, and ~8000 credits per view out of a 10M/year pool (~1200
  views/year), so keep auto-refresh restrained with it.
- **Pirate Weather**: Dark Sky compatible multi-model blend with richer
  US fields (minutely nowcast, alerts); needs `PIRATE_WEATHER_API_KEY`.

The backend translates each provider into one Dark Sky-shaped document
(meteoblue's is a meteoblue/Open-Meteo merge), so the frontend pipeline
is provider-agnostic. Location search comes from OpenStreetMap
Nominatim.
## What the timeline shows

1. **Precipitation**: hourly intensity bars tiled as a histogram
   (sqrt-scaled, colored by type), the API's intensity error as a soft
   halo where reported, a probability line, per-minute nowcast bars
   where pixels allow, and per-day accumulation totals.
2. **Temperature**: smoothed hourly temperature and apparent temperature
   lines, with high and low temperature labels for each day.
3. **Wind**: speed and gust lines with WMO wind barbs (shaft points
   where the wind comes from; feathers mark 5/10/50 knot classes).
4. **Cloud / UV**: the Open-Meteo low/mid/high cloud series are merged
   into one gray density mass (darker = more total cover), and a UV step
   line with value labels runs on top.

Night hours are shaded with one flat tint, midnight boundaries are
dashed, and a two-tier axis (day names over clock hours) is drawn in the
location's timezone on both the top and the bottom. Day labels stay
horizontal until one would not fit its day span; then the whole row
rotates together so every day label reads the same way. Hour labels
always show a complete arithmetic progression inside each part of a day
(0 3 6 9 ... or 0 6 12 18, never a sequence with a hole); the part
before and the part after "now" may use different steps because the
warp makes their densities different. Near-now hours of the current day
also get faint dashed gridlines, aligned one-to-one with the labeled
hours. Data left of the "now" anchor fades to 45% opacity at the range
edge.

Hover or use arrow keys (Shift for day steps) for a crosshair that puts
interpolation dots on every series, with a tooltip listing all reported
fields for the nearest sample and its tier (per-minute, hourly, or daily
aggregate).

The axis is a true fisheye lens: the warp function family (power, log,
asinh, atan, linear) and strength are selectable, and a slider sets
where "now" sits on the axis. Past range (0-14 days) and future range
(1-7 days, the API maximum) adjust the data window; units
(si/us/ca/uk/uk2), summary language, theme (auto/light/dark), and
layout persist in localStorage. The layout toggle switches between a
full-height chart and a compact one centered on screen; band order,
relative band heights, and the compact height are all adjustable. `f`
toggles focus mode (chart only). An optional auto-refresh refetches data
at a configurable interval while the tab is visible. The styling aims
for a quiet scientific chart: one near-neutral ink family per theme with
no accent hues.

With provider=pirateweather, the model blend behind the forecast is
adjustable in settings: any of Pirate Weather's model families (HRRR,
NBM, GFS, GEFS, RTMA, ECMWF IFS, MOSMIX, RAQDPS, SILAM) can be excluded,
and the AI family (AIGFS/AIGEFS/ECMWF-AIFS) can be included via
`include=aimodels`. The blend is a single merged series upstream;
per-model plots are not possible with this API. These settings are
Pirate-specific and hidden for provider=openmeteo.

## Architecture

- `src/`: Rust (axum) server. Fetches from the selected provider
  (`openmeteo.rs`, `meteoblue.rs`, and `pirate.rs` + `merge.rs` each
  produce the shared Dark Sky shape; meteoblue overlays its fields onto
  an Open-Meteo document), caches results, proxies Nominatim geocoding,
  serves the frontend.
- `frontend/`: Solid + Vite + TypeScript. The timeline is one
  DPR-aware canvas; Solid renders only the chrome (search, settings,
  current conditions, alerts, tooltip).

Why the merge is server-side: the API key (only Pirate Weather needs
one) never reaches the browser, the browser CORS question disappears, and
caching cuts quota usage. Past days are immutable and cached permanently;
forecasts and today's live day refresh every 10 minutes. With
provider=openmeteo, one view costs exactly one upstream call (forecast +
past days + cloud layers + nowcast ride in a single response), and
Open-Meteo non-commercial use allows 10,000 calls/day. With
provider=pirateweather, one cold view costs `1 + past_days` calls against
the 10,000 calls/month free tier, so caching is the difference between
comfortable and quota exhaustion.

### Precisions worth knowing

- Pirate Weather timemachine data is model archive (last 10 days: GFS;
  older: ERA5, ca. 10 days behind realtime), not station observations.
  Open-Meteo past days are model output as well. Past hours are modeled
  history either way; the footer says so.
- Open-Meteo has no per-minute nowcast, no alerts, and no intensity
  error field; `minutely` is 15-minute data (next 2 hours only), alerts
  are always empty, and the precip error halo is absent. Conversely,
  Open-Meteo needs no key and is one call per view.
- The meteoblue free tier has no cloud-cover layers, no gusts, no
  visibility, no sun/moon data, no alerts, and no nowcast; all of these
  are filled from Open-Meteo, and meteoblue fields win where both have
  them. History is capped at 4 days back (`historyDays` limit).
- The backend API keeps Pirate Weather field names verbatim; the
  frontend renders only what is present (field coverage varies by model
  source and location).
- Pirate Weather resolves to ~13 km model cells; coordinates are rounded
  to 3 decimals everywhere (cache keys and upstream requests).
- Cloud cover by altitude comes from Open-Meteo and is fetched
  concurrently; if it fails, the weather response still succeeds with a
  warning in `meta.warnings`.
- The only uncertainty field upstream offers is `precipIntensityError`,
  shown as a halo around future bars. No temperature or wind spread
  exists in this API, so none is shown.
## HTTP API

All routes are unauthenticated and assume a trusted network (see
*Deployment considerations*).

- `GET /api/weather?lat=&lon=&past_days=&units=&lang=&provider=`
  Merged document: Dark Sky-shaped; `hourly.data` covers past days plus
  168 forecast hours, `daily.data` covers past days plus 7 forecast days.
  `meta.warnings` lists partially failed past-day loads. `provider` is
  `openmeteo` (default), `meteoblue`, or `pirateweather`; selecting a
  provider whose API key is not configured on the server returns 503.
- `GET /api/geocode?q=&lang=` -> `[{name, lat, lon}]`
- `GET /api/reverse?lat=&lon=&lang=` -> `{name, lat, lon}`
- `GET /api/health`

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PIRATE_WEATHER_API_KEY` | unset | Pirate Weather API key; optional -- only required for provider=pirateweather requests |
| `METEOBLUE_API_KEY` | unset | meteoblue API key (free-tier trial, 10M credits/year); only required for provider=meteoblue |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8087` | Port |
| `WEATHER_UI_STATIC_DIR` | `./frontend/dist` | Built frontend to serve |
| `NOMINATIM_BASE_URL` | public OSM endpoint | Geocoding service |
| `NOMINATIM_CONTACT` | unset | Added to the Nominatim user agent, e.g. an email |
| `RUST_LOG` | `weather_ui=info,tower_http=info` | Log filter |

## Run the released image

Multi-arch (amd64 + arm64) images are published to GHCR from tagged
releases:

```console
docker run --rm -p 8087:8087 \
  -e METEOBLUE_API_KEY=... \    # optional, needed only for that provider
  -e PIRATE_WEATHER_API_KEY=... # optional
  ghcr.io/msimberg/weather-ui:latest
```

Static musl binaries (x86_64 and arm64, fully self-contained) are
attached to each GitHub release for systems without a container runtime.

Releases are automated: conventional commits accumulate into a
release-please PR, and merging that PR tags the version, builds the
binaries and images, and generates CHANGELOG.md.

## Build from source

```sh
docker build -t weather-ui .
docker run --rm -p 8087:8087 weather-ui
# add -e PIRATE_WEATHER_API_KEY=... / -e METEOBLUE_API_KEY=... for those providers
```

or

```sh
docker compose up --build
```

Then open http://localhost:8087.

## Local development

```sh
# terminal 1: backend on :8087 (requires cargo; builds frontend first or run vite separately)
cargo run

# terminal 2: frontend dev server on :5173 with HMR, proxying /api to :8087
cd frontend
npm install
npm run dev
```

To run the backend against a pre-built frontend: `npm run build` in
`frontend/`, then `cargo run` and open http://127.0.0.1:8087.

## Tests

```sh
cargo test            # backend: merge dedup, cache TTL, validation, error mapping
cd frontend && npm test   # frontend: axis warps/inverses, timezone day math, formatting
```

## Deployment considerations

The server has no authn/authz and is meant for localhost or a trusted
LAN. If exposed further, put it behind a reverse proxy with TLS and
access control: any visitor can fetch weather (consuming your provider
quote/credits) but cannot see the API keys themselves.
