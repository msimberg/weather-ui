# weather-ui

A weather dashboard built around a single continuous time axis with a
focus+context (fisheye) warp: the hours around "now" are spread out and
shown in full detail, and data compresses smoothly with distance in both
directions. There are no separate hourly/daily/weekly views. One axis,
past days fading into lower detail on the left, forecast days compressing
into daily summary bands on the right.

Data comes from [Pirate Weather](https://pirateweather.net) (Dark Sky
compatible), location search from OpenStreetMap Nominatim, and
altitude-layered cloud cover from Open-Meteo (no key required).
## What the timeline shows

1. **Precipitation**: hourly intensity bars tiled as a histogram
   (sqrt-scaled, colored by type), the API's intensity error as a soft
   halo where reported, a probability line, per-minute nowcast bars
   where pixels allow, and per-day accumulation totals.
2. **Temperature**: smoothed hourly temperature and apparent temperature
   lines. Where the axis compresses below reading density, lines
   crossfade into a smooth envelope through the daily min/max extremes
   with H/L labels. All handoffs are driven by pixel density, not fixed
   cutoffs.
3. **Wind**: speed and gust lines with WMO wind barbs (shaft points
   where the wind comes from; feathers mark 5/10/50 knot classes).
4. **Cloud / UV**: default is density shading (column darkness = total
   cover) plus low/mid/high layer hairlines from Open-Meteo and a UV
   line; a settings toggle restores the area rendering.

Night hours are shaded with one flat tint, midnight boundaries are
dashed, and a two-tier axis (day names over clock hours) is drawn in the
location's timezone. Everything left of the "now" anchor fades to 45%
opacity at the range edge.

Hover or use arrow keys (Shift for day steps) for a crosshair that puts
interpolation dots on every series, with a tooltip listing all reported
fields for the nearest sample and its tier (per-minute, hourly, or daily
aggregate).

The axis is a true fisheye lens: the warp function family (power, log,
asinh, atan, linear) and strength are selectable, and a slider sets
where "now" sits on the axis. Past range (0-14 days) and future range
(1-7 days, the API maximum) adjust the data window; units
(si/us/ca/uk/uk2), summary language, theme (auto/light/dark), layout
(full/compact), and cloud rendering mode persist in localStorage. `f`
toggles focus mode (chart only). The styling aims for a quiet scientific
chart: monochrome inks with one muted hue for temperature.

The model blend behind the forecast is adjustable in settings: any of
Pirate Weather's model families (HRRR, NBM, GFS, GEFS, RTMA, ECMWF IFS,
MOSMIX, RAQDPS, SILAM) can be excluded, and the AI family
(AIGFS/AIGEFS/ECMWF-AIFS) can be included via `include=aimodels`. The
blend is a single merged series upstream; per-model plots are not
possible with this API.

## Architecture

- `src/`: Rust (axum) server. Proxies Pirate Weather, merges forecast +
  per-past-day timemachine responses into one Dark Sky-shaped document,
  caches results, proxies Nominatim geocoding, serves the frontend.
- `frontend/`: Solid + Vite + TypeScript. The timeline is one
  DPR-aware canvas; Solid renders only the chrome (search, settings,
  current conditions, alerts, tooltip).

Why the merge is server-side: the API key never reaches the browser,
the browser CORS question disappears, and caching cuts quota usage.
Past days are immutable and cached permanently; forecasts and today's
live day refresh every 10 minutes. Pirate Weather's free tier is 10,000
calls/month, and one cold view costs `1 + past_days` upstream calls, so
this caching is the difference between comfortable and quota exhaustion.

### Precisions worth knowing

- Timemachine data is model archive (last 10 days: GFS; older: ERA5, ca.
  10 days behind realtime), not station observations. Past hours are
  therefore modeled history; the footer says so.
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

- `GET /api/weather?lat=&lon=&past_days=&units=&lang=`
  Merged document: Dark Sky-shaped; `hourly.data` covers past days plus
  168 forecast hours, `daily.data` covers past days plus 7 forecast days.
  `meta.warnings` lists partially failed past-day loads.
- `GET /api/geocode?q=&lang=` -> `[{name, lat, lon}]`
- `GET /api/reverse?lat=&lon=&lang=` -> `{name, lat, lon}`
- `GET /api/health`

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PIRATE_WEATHER_API_KEY` | (required) | Pirate Weather API key; server exits if missing |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8087` | Port |
| `WEATHER_UI_STATIC_DIR` | `./frontend/dist` | Built frontend to serve |
| `NOMINATIM_BASE_URL` | public OSM endpoint | Geocoding service |
| `NOMINATIM_CONTACT` | unset | Added to the Nominatim user agent, e.g. an email |
| `RUST_LOG` | `weather_ui=info,tower_http=info` | Log filter |

## Run with Docker

```sh
docker build -t weather-ui .
docker run --rm -e PIRATE_WEATHER_API_KEY -p 8087:8087 weather-ui
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
access control: any visitor can fetch weather (consuming your Pirate
Weather quota) but cannot see the API key itself.
