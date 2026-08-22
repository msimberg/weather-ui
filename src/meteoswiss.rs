// MeteoSwiss provider: keyless, CC-BY local forecast data from Switzerland's
// Federal Spatial Data Infrastructure (FSDI) STAC API. This is the same
// forecast the MeteoSwiss app and website show per postal code -- the official
// Swiss post-processed point forecast (mix of ICON-CH1/2-EPS, INCA, ECMWF),
// for ~5,600 points across Switzerland, +0h to +192h, updated hourly.
//
// The catch (verified 2026-08): there is no per-point query today. Each
// parameter is one bulk CSV holding every point x every hour (up to ~1.24 M
// rows, ~25-33 MB). We download the handful of parameters the forecast bands
// actually draw, stream-scan each file for the single nearest point, and cache
// the parsed series for one hour so the bulk download amortizes across
// refreshes (the upstream data changes hourly). Peak memory is one CSV body at
// a time because the files are fetched sequentially.
//
// What MeteoSwiss gives us (and wins): temperature, wind speed, wind gusts,
// wind direction, hourly precipitation, precipitation probability, and the
// official MeteoSwiss weather pictogram (icon/summary). What it lacks, filled
// from Open-Meteo like the meteoblue provider: UV index, humidity, dew point,
// pressure, visibility, apparent temperature, sunrise/sunset, moon phase, the
// 15-minute nowcast, and the cloud-cover-by-altitude layers (Open-Meteo serves
// those keyless for Switzerland from the same ICON-CH family).
//
// Coverage is Switzerland only. Outside the point catalog's bounding box or
// beyond ~50 km of the nearest Swiss point, this provider degrades to an
// Open-Meteo-only document with a meta warning.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::pirate::UpstreamError;

const STAC_BASE: &str = "https://data.geo.admin.ch/api/stac/v1";
const COLLECTION: &str = "ch.meteoschweiz.ogd-local-forecasting";
const META_POINT_URL: &str =
    "https://data.geo.admin.ch/ch.meteoschweiz.ogd-local-forecasting/ogd-local-forecasting_meta_point.csv";

/// How long the parsed series for a point stays fresh. MeteoSwiss publishes a
/// new run every hour, so one download per hour per active point is the floor;
/// the server's response cache (routes::FORECAST_TTL) is shorter, which is why
/// this second cache exists.
const SERIES_TTL: Duration = Duration::from_secs(3600);

/// Nearest Swiss point must be within this distance, otherwise the location is
/// treated as outside MeteoSwiss coverage (e.g. Milan, ~80 km from Chiasso).
const MAX_POINT_DISTANCE_KM: f64 = 50.0;

/// Swiss point catalog bounding box (WGS84), used as a fast reject before
/// touching the network for clearly non-Swiss locations.
const CH_BBOX: ((f64, f64), (f64, f64)) = ((45.8, 5.9), (47.85, 10.5));

/// One catalog row from ogd-local-forecasting_meta_point.csv.
#[derive(Clone)]
struct Point {
    id: i64,
    lat: f64,
    lon: f64,
    elevation: f64,
}

#[derive(Clone)]
pub struct MeteoSwissClient {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    /// Point catalog, fetched once for the process lifetime (new POIs are
    /// added rarely). None means not yet fetched or last fetch failed.
    points: Mutex<Option<Vec<Point>>>,
    /// Cached parsed series per point: point_id -> (fetched_at, json doc).
    /// The doc is the small per-point translation input (see forecast()).
    series: Mutex<HashMap<i64, (Instant, Value)>>,
}

impl MeteoSwissClient {
    pub fn new(user_agent: String) -> MeteoSwissClient {
        let http = reqwest::Client::builder()
            .user_agent(user_agent)
            // One bulk CSV is ~30 MB on a slow link; allow generous time.
            .timeout(Duration::from_secs(120))
            .build()
            .expect("reqwest client construction failed");
        MeteoSwissClient {
            inner: Arc::new(Inner {
                http,
                points: Mutex::new(None),
                series: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Fetch the per-point forecast for the nearest MeteoSwiss point to
    /// `(lat, lon)`. Returns a small Dark-Sky-shaped intermediate:
    /// `{ latitude, longitude, elevation, init, series: { <param>: {time, value} } }`.
    /// Returns an empty doc (`{}`) when the location is outside MeteoSwiss
    /// coverage, so the caller's merge degrades to Open-Meteo only.
    pub async fn forecast(&self, lat: f64, lon: f64) -> Result<Value, UpstreamError> {
        if !in_bbox(lat, lon) {
            return Ok(json!({}));
        }
        let point = self.nearest_point(lat, lon).await?;
        let Some(point) = point else {
            return Ok(json!({}));
        };

        if let Some((at, doc)) = self
            .inner
            .series
            .lock()
            .expect("lock")
            .get(&point.id)
            .cloned()
        {
            if at.elapsed() < SERIES_TTL {
                return Ok(doc);
            }
        }

        let Some(feature) = self.latest_feature().await? else {
            return Ok(json!({}));
        };
        let assets = feature
            .get("assets")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        // Fetch each parameter's CSV sequentially (one ~30 MB body in memory at
        // a time) and keep only this point's rows.
        let mut series = Map::new();
        let mut init: Option<i64> = None;
        for param in HOURLY_PARAMS {
            let Some(href) = resolve_asset(&assets, param) else {
                continue;
            };
            let (times, values, run) = self.fetch_param(&href, point.id, param).await?;
            init = Some(init.unwrap_or(run).max(run));
            series.insert(param.to_string(), json!({ "time": times, "value": values }));
        }
        let doc = json!({
            "point_id": point.id,
            "latitude": point.lat,
            "longitude": point.lon,
            "elevation": point.elevation,
            "init": init,
            "series": series,
        });
        self.inner
            .series
            .lock()
            .expect("lock")
            .insert(point.id, (Instant::now(), doc.clone()));
        Ok(doc)
    }

    async fn nearest_point(&self, lat: f64, lon: f64) -> Result<Option<Point>, UpstreamError> {
        let cached = self.inner.points.lock().expect("lock").clone();
        let points = match cached {
            Some(p) => p,
            None => {
                let p = self.fetch_points().await?;
                *self.inner.points.lock().expect("lock") = Some(p.clone());
                p
            }
        };
        let mut best: Option<(f64, Point)> = None;
        for pt in &points {
            let d = haversine_km(lat, lon, pt.lat, pt.lon);
            if best.as_ref().is_none_or(|(bd, _)| d < *bd) {
                best = Some((
                    d,
                    Point {
                        id: pt.id,
                        lat: pt.lat,
                        lon: pt.lon,
                        elevation: pt.elevation,
                    },
                ));
            }
        }
        Ok(best.and_then(|(d, p)| (d <= MAX_POINT_DISTANCE_KM).then_some(p)))
    }

    async fn fetch_points(&self) -> Result<Vec<Point>, UpstreamError> {
        let resp = self
            .inner
            .http
            .get(META_POINT_URL)
            .send()
            .await
            .map_err(|e| UpstreamError::Network {
                service: "meteoswiss",
                detail: format!("point catalog: {e}"),
            })?;
        let status = resp.status();
        if !status.is_success() {
            return Err(UpstreamError::Status {
                status,
                service: "meteoswiss",
                detail: "point catalog".to_string(),
            });
        }
        let bytes = resp.bytes().await.map_err(|e| UpstreamError::Network {
            service: "meteoswiss",
            detail: format!("point catalog body: {e}"),
        })?;
        let text = String::from_utf8_lossy(&bytes);
        let mut out = Vec::new();
        for line in text.lines() {
            // point_id;point_type_id;station_abbr;postal_code;name;...;elevation;lv95e;lv95n;lat;lon
            let mut it = line.split(';');
            let Some(Ok(id)) = it.next().map(str::parse::<i64>) else {
                continue;
            };
            let _ = it.next(); // point_type_id
            let _ = it.next(); // station_abbr
            let _ = it.next(); // postal_code
            let _ = it.next(); // name
            let _ = it.next(); // point_type_de
            let _ = it.next(); // point_type_fr
            let _ = it.next(); // point_type_it
            let _ = it.next(); // point_type_en
            let Some(Ok(elevation)) = it.next().map(str::parse::<f64>) else {
                continue;
            };
            let _ = it.next(); // lv95 east
            let _ = it.next(); // lv95 north
            let Some(Ok(lat)) = it.next().map(str::parse::<f64>) else {
                continue;
            };
            let Some(Ok(lon)) = it.next().map(str::parse::<f64>) else {
                continue;
            };
            if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
                continue;
            }
            out.push(Point {
                id,
                lat,
                lon,
                elevation,
            });
        }
        Ok(out)
    }

    /// The newest day-item that carries downloadable assets. Each item id is a
    /// YYYYMMDD-ch date string; asset keys within it are
    /// "vnut12.lssw.<YYYYMMDDHHMM>.<param>.csv" and sort lexically, so the
    /// newest run for a parameter is the max key ending in ".<param>.csv".
    async fn latest_feature(&self) -> Result<Option<Value>, UpstreamError> {
        let url = format!("{STAC_BASE}/collections/{COLLECTION}/items?limit=10");
        let resp = self
            .inner
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| UpstreamError::Network {
                service: "meteoswiss",
                detail: format!("items: {e}"),
            })?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let excerpt: String = body.chars().take(200).collect();
            return Err(UpstreamError::Status {
                status,
                service: "meteoswiss",
                detail: excerpt,
            });
        }
        let v: Value = resp.json().await.map_err(|e| UpstreamError::Network {
            service: "meteoswiss",
            detail: format!("items body: {e}"),
        })?;
        let features = v
            .get("features")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(features
            .into_iter()
            .filter(|f| {
                f.get("id").and_then(Value::as_str).is_some()
                    && f.get("assets")
                        .and_then(Value::as_object)
                        .is_some_and(|a| !a.is_empty())
            })
            .max_by(|a, b| {
                a.get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .cmp(b.get("id").and_then(Value::as_str).unwrap_or(""))
            }))
    }

    /// Download one parameter CSV and return `(times, values)` for `point_id`,
    /// plus the run timestamp (the YYYYMMDDHHMM of the asset) for attribution.
    /// Times are shifted -3600s from the CSV's end-of-hour reference to the
    /// start-of-hour convention the rest of the app uses.
    async fn fetch_param(
        &self,
        href: &str,
        point_id: i64,
        param: &str,
    ) -> Result<(Vec<i64>, Vec<Value>, i64), UpstreamError> {
        let resp = self
            .inner
            .http
            .get(href)
            .send()
            .await
            .map_err(|e| UpstreamError::Network {
                service: "meteoswiss",
                detail: format!("{param}: {e}"),
            })?;
        let status = resp.status();
        if !status.is_success() {
            return Err(UpstreamError::Status {
                status,
                service: "meteoswiss",
                detail: param.to_string(),
            });
        }
        let bytes = resp.bytes().await.map_err(|e| UpstreamError::Network {
            service: "meteoswiss",
            detail: format!("{param} body: {e}"),
        })?;
        let text = String::from_utf8_lossy(&bytes);
        let prefix = format!("{point_id};");
        let mut times = Vec::new();
        let mut values = Vec::new();
        for line in text.lines() {
            if !line.starts_with(&prefix) {
                continue;
            }
            let mut it = line.split(';');
            let _ = it.next(); // point_id
            let _ = it.next(); // point_type_id
            let Some(date) = it.next() else {
                continue;
            };
            let Some(val) = it.next() else {
                continue;
            };
            let Some(epoch) = parse_yyyymmddhm_utc(date) else {
                continue;
            };
            if let Ok(f) = val.parse::<f64>() {
                times.push(epoch - 3600); // end-of-hour -> start-of-hour
                values.push(json!(f));
            }
        }
        let run = href
            .rsplit('/')
            .next()
            .and_then(|name| name.strip_prefix("vnut12.lssw."))
            .and_then(|s| s.get(0..12))
            .and_then(parse_yyyymmddhm_utc)
            .unwrap_or(0);
        Ok((times, values, run))
    }
}

/// Parameter shortnames fetched for the forecast bands.
const HOURLY_PARAMS: &[&str] = &[
    "tre200h0", // temperature 2m, hourly mean (deg C)
    "fu3010h0", // wind speed, hourly mean (km/h)
    "fu3010h1", // wind gust peak, hourly max (km/h)
    "dkl010h0", // wind direction, hourly mean (deg)
    "rre150h0", // precipitation, hourly total (mm)
    "rp0003i0", // precipitation probability, 3h (percent)
    "jww003i0", // MeteoSwiss weather pictogram, 3h (integer)
];

/// Find the newest asset key for `param` within a feature's asset map and
/// return its href. Keys are "vnut12.lssw.<YYYYMMDDHHMM>.<param>.csv".
fn resolve_asset(assets: &serde_json::Map<String, Value>, param: &str) -> Option<String> {
    let suffix = format!(".{param}.csv");
    let mut best_key: Option<&str> = None;
    for key in assets.keys() {
        if key.ends_with(&suffix) && best_key.is_none_or(|b| key.as_str() > b) {
            best_key = Some(key);
        }
    }
    best_key.and_then(|k| {
        assets
            .get(k)?
            .get("href")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn in_bbox(lat: f64, lon: f64) -> bool {
    let ((lat0, lon0), (lat1, lon1)) = CH_BBOX;
    lat >= lat0 && lat <= lat1 && lon >= lon0 && lon <= lon1
}

/// Great-circle distance in km (spherical earth, radius 6371 km).
fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6371.0;
    let to_rad = |d: f64| d.to_radians();
    let (la1, la2) = (to_rad(lat1), to_rad(lat2));
    let dlat = to_rad(lat2 - lat1);
    let dlon = to_rad(lon2 - lon1);
    let a = (dlat / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * R * a.sqrt().asin()
}

/// Parse "YYYYMMDDHHMM" as a UTC epoch second. Howard Hinnant's civil-to-days
/// formula, no chrono dependency (a wrong parse would silently shift every
/// label, so this is unit-tested like meteoblue's ISO parser).
pub fn parse_yyyymmddhm_utc(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 12 || !b.iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(4..6)?.parse().ok()?;
    let day: i64 = s.get(6..8)?.parse().ok()?;
    let hour: i64 = s.get(8..10)?.parse().ok()?;
    let minute: i64 = s.get(10..12)?.parse().ok()?;
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86_400 + hour * 3600 + minute * 60)
}

// --- unit conversion ---------------------------------------------------

/// MeteoSwiss temperature arrives in deg C regardless of the requested units.
fn convert_temp_c(c: f64, units: &str) -> f64 {
    if units == "us" {
        c * 9.0 / 5.0 + 32.0
    } else {
        c
    }
}

/// MeteoSwiss wind arrives in km/h regardless of the requested units.
fn convert_wind_kmh(kmh: f64, units: &str) -> f64 {
    match units {
        "ca" => kmh,
        "us" | "uk" | "uk2" => kmh / 1.609_344, // km/h -> mph
        _ => kmh / 3.6,                         // si: m/s
    }
}

/// MeteoSwiss hourly precipitation arrives in mm regardless of units.
fn convert_precip_mm(mm: f64, units: &str) -> f64 {
    if units == "us" {
        mm / 25.4
    } else {
        mm
    }
}

// --- pictogram -> Dark Sky icon ---------------------------------------

/// MeteoSwiss weather pictogram (base = value % 100; value >= 100 is the night
/// variant) -> (summary, day icon, night icon, precip type). Icons use the
/// Dark Sky vocabulary so the frontend needs no changes. The 84-entry mapping
/// comes from MeteoSwiss's official "Weather symbols" reference (XLSX, Feb
/// 2022): values 1-42 day, 101-142 night.
fn pictogram(
    base: i64,
) -> (
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
) {
    match base {
        1 => ("Sunny", "clear-day", "clear-night", None),
        2 => ("Mostly sunny", "clear-day", "clear-night", None),
        3 => (
            "Partly cloudy",
            "partly-cloudy-day",
            "partly-cloudy-night",
            None,
        ),
        4 => ("Overcast", "cloudy", "cloudy", None),
        5 => ("Very cloudy", "cloudy", "cloudy", None),
        6 => ("Isolated showers", "rain", "rain", Some("rain")),
        7 => ("Isolated sleet", "sleet", "sleet", Some("sleet")),
        8 => ("Snow showers", "snow", "snow", Some("snow")),
        9 => ("Rain showers", "rain", "rain", Some("rain")),
        10 => ("Sleet showers", "sleet", "sleet", Some("sleet")),
        11 => ("Snow showers", "snow", "snow", Some("snow")),
        12 => (
            "Chance of thunderstorms",
            "thunderstorm",
            "thunderstorm",
            Some("rain"),
        ),
        13 => (
            "Possible thunderstorms",
            "thunderstorm",
            "thunderstorm",
            Some("rain"),
        ),
        14 => ("Light rain", "rain", "rain", Some("rain")),
        15 => ("Light sleet", "sleet", "sleet", Some("sleet")),
        16 => ("Light snow showers", "snow", "snow", Some("snow")),
        17 => ("Intermittent rain", "rain", "rain", Some("rain")),
        18 => ("Intermittent sleet", "sleet", "sleet", Some("sleet")),
        19 => ("Intermittent snow", "snow", "snow", Some("snow")),
        20 => ("Rain", "rain", "rain", Some("rain")),
        21 => ("Frequent sleet", "sleet", "sleet", Some("sleet")),
        22 => ("Heavy snow", "snow", "snow", Some("snow")),
        23 => (
            "Slight chance of storms",
            "thunderstorm",
            "thunderstorm",
            Some("rain"),
        ),
        24 => ("Storms", "thunderstorm", "thunderstorm", Some("rain")),
        25 => ("Very stormy", "thunderstorm", "thunderstorm", Some("rain")),
        26 => (
            "High clouds",
            "partly-cloudy-day",
            "partly-cloudy-night",
            None,
        ),
        27 => ("Stratus", "cloudy", "cloudy", None),
        28 => ("Fog", "fog", "fog", None),
        29 => ("Scattered showers", "rain", "rain", Some("rain")),
        30 => ("Scattered snow showers", "snow", "snow", Some("snow")),
        31 => ("Scattered sleet", "sleet", "sleet", Some("sleet")),
        32 => ("Some showers", "rain", "rain", Some("rain")),
        33 => ("Frequent rain", "rain", "rain", Some("rain")),
        34 => ("Frequent snowfalls", "snow", "snow", Some("snow")),
        35 => ("Overcast and dry", "cloudy", "cloudy", None),
        36 => (
            "Slightly stormy",
            "thunderstorm",
            "thunderstorm",
            Some("rain"),
        ),
        37 => (
            "Stormy snow showers",
            "thunderstorm",
            "thunderstorm",
            Some("snow"),
        ),
        38 => (
            "Thundery showers",
            "thunderstorm",
            "thunderstorm",
            Some("rain"),
        ),
        39 => (
            "Thundery snow showers",
            "thunderstorm",
            "thunderstorm",
            Some("snow"),
        ),
        40 => (
            "Slightly stormy",
            "thunderstorm",
            "thunderstorm",
            Some("rain"),
        ),
        41 => (
            "Slightly stormy",
            "thunderstorm",
            "thunderstorm",
            Some("rain"),
        ),
        42 => (
            "Thundery snow showers",
            "thunderstorm",
            "thunderstorm",
            Some("snow"),
        ),
        _ => ("Unknown", "cloudy", "cloudy", None),
    }
}

// --- translation -------------------------------------------------------

/// Build Dark-Sky-shaped per-hour slots from the parsed MeteoSwiss series.
/// Only the fields MeteoSwiss provides are emitted; the merge with Open-Meteo
/// fills the rest (humidity, uv, visibility, apparent temperature, cloud).
fn meteoswiss_hours(ms: &Value, units: &str) -> Vec<Value> {
    let Some(series) = ms.get("series").and_then(Value::as_object) else {
        return Vec::new();
    };
    // Collect each parameter into a time->value map, and the union of times.
    let mut by_param: HashMap<&str, HashMap<i64, f64>> = HashMap::new();
    let mut all_times: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
    for (param, arr) in series {
        let Some(t) = arr.get("time").and_then(Value::as_array) else {
            continue;
        };
        let Some(v) = arr.get("value").and_then(Value::as_array) else {
            continue;
        };
        let map: HashMap<i64, f64> = t
            .iter()
            .zip(v.iter())
            .filter_map(|(tt, vv)| Some((tt.as_i64()?, vv.as_f64()?)))
            .collect();
        for &k in map.keys() {
            all_times.insert(k);
        }
        // Map the raw param shortname back to the canonical key used below.
        by_param.insert(param.as_str(), map);
    }
    let get = |p: &str, t: i64| by_param.get(p).and_then(|m| m.get(&t).copied());

    let mut out = Vec::with_capacity(all_times.len());
    for t in all_times {
        let mut slot = Map::new();
        slot.insert("time".to_string(), json!(t));
        if let Some(v) = get("tre200h0", t) {
            slot.insert("temperature".to_string(), json!(convert_temp_c(v, units)));
        }
        if let Some(v) = get("fu3010h0", t) {
            slot.insert("windSpeed".to_string(), json!(convert_wind_kmh(v, units)));
        }
        if let Some(v) = get("fu3010h1", t) {
            slot.insert("windGust".to_string(), json!(convert_wind_kmh(v, units)));
        }
        if let Some(v) = get("dkl010h0", t) {
            slot.insert("windBearing".to_string(), json!(v));
        }
        if let Some(v) = get("rre150h0", t) {
            let p = convert_precip_mm(v, units);
            slot.insert("precipIntensity".to_string(), json!(p));
            slot.insert("liquidAccumulation".to_string(), json!(p));
        }
        if let Some(v) = get("rp0003i0", t) {
            slot.insert("precipProbability".to_string(), json!(v / 100.0));
        }
        if let Some(v) = get("jww003i0", t).map(|f| f as i64) {
            let is_night = v >= 100;
            let base = v % 100;
            let (summary, day, night, ptype) = pictogram(base);
            slot.insert("summary".to_string(), json!(summary));
            slot.insert(
                "icon".to_string(),
                json!(if is_night { night } else { day }),
            );
            if !slot.contains_key("precipType") {
                if let Some(p) = ptype {
                    slot.insert("precipType".to_string(), json!(p));
                }
            }
        }
        out.push(Value::Object(slot));
    }
    out
}

/// Derive Dark-Sky daily rows from the MeteoSwiss hourly series, bucketed by
/// local day (using the Open-Meteo offset, since MeteoSwiss carries no
/// timezone). Open-Meteo fills sunrise/sunset, moon phase, uv max, and
/// apparent-temperature H/L during the merge.
fn meteoswiss_days(hours: &[Value], offset_hours: f64, units: &str) -> Vec<Value> {
    let offset_secs = (offset_hours * 3600.0).round() as i64;
    let mut days: BTreeMap<i64, Map<String, Value>> = BTreeMap::new();
    for h in hours {
        let Some(t) = h.get("time").and_then(Value::as_i64) else {
            continue;
        };
        let day_start = (t + offset_secs).div_euclid(86_400) * 86_400 - offset_secs;
        let d = days.entry(day_start).or_default();
        d.insert("time".to_string(), json!(day_start));
        if let Some(temp) = h.get("temperature").and_then(Value::as_f64) {
            if d.get("temperatureHigh")
                .and_then(Value::as_f64)
                .is_none_or(|m| temp > m)
            {
                d.insert("temperatureHigh".to_string(), json!(temp));
                d.insert("temperatureHighTime".to_string(), json!(t));
            }
            if d.get("temperatureLow")
                .and_then(Value::as_f64)
                .is_none_or(|m| temp < m)
            {
                d.insert("temperatureLow".to_string(), json!(temp));
                d.insert("temperatureLowTime".to_string(), json!(t));
            }
        }
        if let Some(p) = h.get("precipIntensity").and_then(Value::as_f64) {
            let acc = d
                .get("precipAccumRaw")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                + p;
            d.insert("precipAccumRaw".to_string(), json!(acc));
            if d.get("precipIntensityMax")
                .and_then(Value::as_f64)
                .is_none_or(|m| p > m)
            {
                d.insert("precipIntensityMax".to_string(), json!(p));
            }
        }
        if let Some(prob) = h.get("precipProbability").and_then(Value::as_f64) {
            if d.get("precipProbability")
                .and_then(Value::as_f64)
                .is_none_or(|m| prob > m)
            {
                d.insert("precipProbability".to_string(), json!(prob));
            }
        }
        if let Some(w) = h.get("windSpeed").and_then(Value::as_f64) {
            if d.get("windSpeed")
                .and_then(Value::as_f64)
                .is_none_or(|m| w > m)
            {
                d.insert("windSpeed".to_string(), json!(w));
            }
        }
        if let Some(g) = h.get("windGust").and_then(Value::as_f64) {
            if d.get("windGust")
                .and_then(Value::as_f64)
                .is_none_or(|m| g > m)
            {
                d.insert("windGust".to_string(), json!(g));
            }
        }
    }
    let mut out = Vec::with_capacity(days.len());
    for (_, mut d) in days {
        let wet = d
            .get("precipIntensityMax")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if wet > 0.1 {
            d.insert("icon".to_string(), json!("rain"));
            d.insert("summary".to_string(), json!("Precipitation expected"));
        }
        let raw = d
            .remove("precipAccumRaw")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        // Daily intensity sum is in mm (si/ca/uk/uk2) or inches (us), matching
        // openmeteo's hourly block. Dark Sky accumulation is cm (non-us) or
        // inches (us) -- divide mm by 10 for non-us so the frontend's
        // `accum * 10` = mm convention stays correct.
        let accum = if units == "us" { raw } else { raw / 10.0 };
        d.insert("precipAccumulation".to_string(), json!(accum));
        out.push(Value::Object(d));
    }
    out
}

/// Public translator: MeteoSwiss hours + days, merged onto the Open-Meteo
/// document. MeteoSwiss wins the forecast fields it provides; Open-Meteo
/// fills UV, humidity, dew point, pressure, visibility, apparent temperature,
/// sun/moon, the 15-minute nowcast, and the cloud layers. When MeteoSwiss has
/// no data for the location, the Open-Meteo document is returned unchanged
/// apart from a meta warning.
pub fn merge(ms: &Value, om_doc: &Value, units: &str) -> Value {
    let offset = om_doc.get("offset").and_then(Value::as_f64).unwrap_or(0.0);

    let mut doc = om_doc.clone();
    let root = doc.as_object_mut().expect("doc is an object");

    let ms_hours = meteoswiss_hours(ms, units);
    if ms_hours.is_empty() {
        // Outside coverage or empty upstream: keep Open-Meteo, add a note.
        let mut meta = root.get("meta").cloned().unwrap_or_else(|| json!({}));
        let mut warnings = meta
            .get("warnings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        warnings.push(json!(
            "MeteoSwiss has no data for this location; showing Open-Meteo"
        ));
        meta["warnings"] = json!(warnings);
        root.insert("meta".to_string(), meta);
        return doc;
    }
    let ms_days = meteoswiss_days(&ms_hours, offset, units);

    // Per-hour overlay keyed by start-of-hour epoch (MeteoSwiss wins shared).
    let mut ms_by_time: HashMap<i64, Value> = HashMap::new();
    for h in &ms_hours {
        if let Some(t) = h.get("time").and_then(Value::as_i64) {
            ms_by_time.insert(t, h.clone());
        }
    }
    let om_hours: Vec<Value> = om_doc
        .get("hourly")
        .and_then(|h| h.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut merged_hours: Vec<Value> = Vec::with_capacity(om_hours.len());
    for oh in &om_hours {
        let Some(t) = oh.get("time").and_then(Value::as_i64) else {
            continue;
        };
        if let Some(mh) = ms_by_time.remove(&t) {
            let mut merged = oh.clone();
            let obj = merged.as_object_mut().expect("hour is an object");
            let mobj = mh.as_object().expect("hour is an object");
            for (k, v) in mobj.iter() {
                if k != "time" {
                    obj.insert(k.clone(), v.clone());
                }
            }
            merged_hours.push(merged);
        } else {
            merged_hours.push(oh.clone());
        }
    }
    for (_, mh) in ms_by_time {
        merged_hours.push(mh);
    }
    merged_hours.sort_by_key(|h| h.get("time").and_then(Value::as_i64).unwrap_or(0));
    let mut hb = root.get("hourly").cloned().unwrap_or_else(|| json!({}));
    hb["data"] = json!(merged_hours);
    root.insert("hourly".to_string(), hb);

    // Daily: MeteoSwiss-derived rows win the weather fields; Open-Meteo's
    // sunrise/sunset, moon phase, uv max, and apparent H/L survive. A dry
    // MeteoSwiss day (no icon) keeps Open-Meteo's daily icon/summary.
    let om_days: Vec<Value> = om_doc
        .get("daily")
        .and_then(|h| h.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut merged_days: Vec<Value> = Vec::with_capacity(om_days.len());
    for od in &om_days {
        let Some(t) = od.get("time").and_then(Value::as_i64) else {
            continue;
        };
        let md = ms_days.iter().find(|md| {
            md.get("time")
                .and_then(Value::as_i64)
                .map(|mt| (mt - t).abs() < 43_200)
                .unwrap_or(false)
        });
        let Some(md) = md else {
            merged_days.push(od.clone());
            continue;
        };
        let mut merged = od.clone();
        let obj = merged.as_object_mut().expect("day is an object");
        let mobj = md.as_object().expect("day is an object");
        for (k, v) in mobj.iter() {
            if k != "time" {
                obj.insert(k.clone(), v.clone());
            }
        }
        if !mobj.contains_key("icon") {
            obj.remove("icon");
            if let Some(ic) = od.get("icon") {
                obj.insert("icon".to_string(), ic.clone());
            }
            if let Some(sm) = od.get("summary") {
                obj.insert("summary".to_string(), sm.clone());
            }
        }
        merged_days.push(merged);
    }
    let mut db = root.get("daily").cloned().unwrap_or_else(|| json!({}));
    db["data"] = json!(merged_days);
    root.insert("daily".to_string(), db);

    // Currently: synthesize from the merged hourly (last slot <= now), like
    // the meteoblue path -- MeteoSwiss has no separate current block.
    let now_sec = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let hours: &Vec<Value> = &root
        .get("hourly")
        .and_then(|h| h.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(slot) = hours
        .iter()
        .rev()
        .find(|h| h.get("time").and_then(Value::as_i64).unwrap_or(0) <= now_sec)
    {
        let mut cur = slot.clone();
        let obj = cur.as_object_mut().expect("hour is an object");
        obj.insert("time".to_string(), json!(now_sec));
        root.insert("currently".to_string(), cur);
    }

    if let Some(elev) = ms.get("elevation").and_then(Value::as_f64) {
        root.insert("elevation".to_string(), json!(elev));
    }
    let mut flags = root.get("flags").cloned().unwrap_or_else(|| json!({}));
    flags["sources"] = json!(["meteoswiss", "open-meteo"]);
    flags["units"] = json!(units);
    root.insert("flags".to_string(), flags);
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_yyyymmddhm_utc_known() {
        // 2026-08-22 08:00 UTC. Cross-checked against MS/OM above.
        // 2026-08-22 08:00 UTC == 1787385600 (verified with `date -u`).
        assert_eq!(parse_yyyymmddhm_utc("202608220800").unwrap(), 1_787_385_600);
    }

    #[test]
    fn parse_yyyymmddhm_utc_start_of_epoch() {
        assert_eq!(parse_yyyymmddhm_utc("197001010000").unwrap(), 0);
    }

    #[test]
    fn parse_yyyymmddhm_utc_rejects_garbage() {
        assert!(parse_yyyymmddhm_utc("").is_none());
        assert!(parse_yyyymmddhm_utc("2026-08-22").is_none());
        assert!(parse_yyyymmddhm_utc("2026082208").is_none());
        assert!(parse_yyyymmddhm_utc("not-a-date9999").is_none());
    }

    #[test]
    fn haversine_zurich_to_geneva() {
        let d = haversine_km(47.3769, 8.5417, 46.2044, 6.1432);
        assert!((d - 224.0).abs() < 5.0, "got {d}");
    }

    #[test]
    fn bbox_accepts_swiss_rejects_milan() {
        assert!(in_bbox(47.3769, 8.5417)); // Zurich
        assert!(!in_bbox(45.4642, 9.1900)); // Milan
    }

    #[test]
    fn pictogram_day_and_night_variants() {
        let (_, d, n, p) = pictogram(1);
        assert_eq!((d, n, p), ("clear-day", "clear-night", None));
        let (_, d, n, p) = pictogram(23);
        assert_eq!((d, n, p), ("thunderstorm", "thunderstorm", Some("rain")));
    }

    fn ms_fixture() -> Value {
        // Two hours for one point, already shifted to start-of-hour.
        // tre200h0 18.0/19.0, fu3010h0 30/40 km/h, rre150h0 0/1.2 mm,
        // rp0003i0 10/80 %, jww003i0 1/23, dkl010h0 90/270.
        json!({
            "point_id": 804600, "latitude": 47.42, "longitude": 8.51,
            "elevation": 410.0, "init": 1_787_382_000,
            "series": {
                "tre200h0": {"time": [1_787_380_000, 1_787_383_600], "value": [18.0, 19.0]},
                "fu3010h0": {"time": [1_787_380_000, 1_787_383_600], "value": [30.0, 40.0]},
                "fu3010h1": {"time": [1_787_380_000, 1_787_383_600], "value": [50.0, 60.0]},
                "dkl010h0": {"time": [1_787_380_000, 1_787_383_600], "value": [90.0, 270.0]},
                "rre150h0": {"time": [1_787_380_000, 1_787_383_600], "value": [0.0, 1.2]},
                "rp0003i0": {"time": [1_787_380_000, 1_787_383_600], "value": [10.0, 80.0]},
                "jww003i0": {"time": [1_787_380_000, 1_787_383_600], "value": [1.0, 23.0]}
            }
        })
    }

    #[test]
    fn meteoswiss_hours_translate_si() {
        let hours = meteoswiss_hours(&ms_fixture(), "si");
        assert_eq!(hours.len(), 2);
        let h = &hours[1];
        assert_eq!(h["temperature"], json!(19.0));
        assert_eq!(h["windSpeed"], json!(40.0 / 3.6)); // km/h -> m/s
        assert_eq!(h["windGust"], json!(60.0 / 3.6));
        assert_eq!(h["windBearing"], json!(270.0));
        assert_eq!(h["precipIntensity"], json!(1.2)); // mm
        assert_eq!(h["precipProbability"], json!(0.8));
        assert_eq!(h["icon"], json!("thunderstorm"));
        assert_eq!(h["summary"], json!("Slight chance of storms"));
        assert_eq!(h["precipType"], json!("rain"));
    }

    #[test]
    fn meteoswiss_hours_us_units() {
        let hours = meteoswiss_hours(&ms_fixture(), "us");
        let h = &hours[1];
        let temp = h["temperature"].as_f64().unwrap();
        assert!((temp - (19.0 * 9.0 / 5.0 + 32.0)).abs() < 1e-9);
        let wind = h["windSpeed"].as_f64().unwrap();
        assert!((wind - 40.0 / 1.609_344).abs() < 1e-9);
        let precip = h["precipIntensity"].as_f64().unwrap();
        assert!((precip - 1.2 / 25.4).abs() < 1e-9);
    }

    #[test]
    fn meteoswiss_hours_night_pictogram() {
        // Pictogram 123 = night variant of base 23 (thunderstorm).
        let mut f = ms_fixture();
        f["series"]["jww003i0"]["value"] = json!([123.0, 23.0]);
        let hours = meteoswiss_hours(&f, "si");
        assert_eq!(hours[0]["icon"], json!("thunderstorm")); // same icon day/night
    }

    fn om_fixture() -> Value {
        json!({
            "latitude": 47.37, "longitude": 8.54, "timezone": "Europe/Zurich",
            "offset": 2.0, "elevation": 409.0,
            "currently": {"time": 1_787_383_600, "temperature": 22.0, "humidity": 0.5, "uvIndex": 3.0, "visibility": 12.0, "apparentTemperature": 21.0},
            "hourly": {"data": [
                {"time": 1_787_380_000, "temperature": 99.0, "humidity": 0.55, "uvIndex": 2.0, "visibility": 11.0, "cloudCover": 0.4, "apparentTemperature": 17.0},
                {"time": 1_787_383_600, "temperature": 99.0, "humidity": 0.6, "uvIndex": 4.0, "visibility": 13.0, "cloudCover": 0.6, "apparentTemperature": 18.0}
            ]},
            "daily": {"data": [
                {"time": 1_787_375_200, "sunriseTime": 1_787_391_600, "sunsetTime": 1_787_428_800, "moonPhase": 0.5, "uvIndexMax": 6.0, "apparentTemperatureHigh": 27.0, "icon": "clear-day", "summary": "Clear"}
            ]},
            "cloudLayers": {"time": [1_787_380_000], "low": [10], "mid": [20], "high": [5]},
            "flags": {"sources": ["open-meteo"], "units": "si"}
        })
    }

    #[test]
    fn merge_meteoswiss_wins_core_om_fills_rest() {
        let ms = ms_fixture();
        let om = om_fixture();
        let doc = merge(&ms, &om, "si");
        let hours = doc["hourly"]["data"].as_array().unwrap();
        // MeteoSwiss temperature wins over OM's 99.0 placeholder...
        assert_eq!(hours[1]["temperature"], json!(19.0));
        // ...while OM-only fields stay.
        assert_eq!(hours[1]["humidity"], json!(0.6));
        assert_eq!(hours[1]["uvIndex"], json!(4.0));
        assert_eq!(hours[1]["visibility"], json!(13.0));
        assert_eq!(hours[1]["cloudCover"], json!(0.6));
        assert_eq!(hours[1]["apparentTemperature"], json!(18.0));
        // cloudLayers and elevation from MS point survive.
        assert_eq!(doc["cloudLayers"]["low"], json!([10]));
        assert_eq!(doc["elevation"], json!(410.0));
        // Daily: MS H/L wins, OM sunrise/sunset/moon/uv/apparent survive.
        let day = &doc["daily"]["data"][0];
        assert_eq!(day["sunriseTime"], json!(1_787_391_600));
        assert_eq!(day["moonPhase"], json!(0.5));
        assert_eq!(day["uvIndexMax"], json!(6.0));
        assert_eq!(day["apparentTemperatureHigh"], json!(27.0));
        assert!(day["temperatureHigh"].as_f64().unwrap() < 30.0);
        // Wettest hour (1.2 mm) -> daily rain icon overrides OM's clear-day.
        assert_eq!(day["icon"], json!("rain"));
        assert!(doc["flags"]["sources"]
            .as_array()
            .unwrap()
            .contains(&json!("meteoswiss")));
    }

    #[test]
    fn merge_empty_meteoswiss_degrades_to_om_with_warning() {
        let om = om_fixture();
        let doc = merge(&json!({}), &om, "si");
        // OM hourly untouched.
        assert_eq!(doc["hourly"]["data"][1]["temperature"], json!(99.0));
        assert_eq!(doc["flags"]["sources"], json!(["open-meteo"]));
        let warnings = doc["meta"]["warnings"].as_array().unwrap();
        assert!(warnings
            .iter()
            .any(|w| w.as_str().unwrap().contains("MeteoSwiss")));
    }
}
