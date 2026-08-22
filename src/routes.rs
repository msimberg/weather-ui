use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header::CACHE_CONTROL, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::task::JoinSet;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::cache::Cache;
use crate::merge;
use crate::meteoblue::{self, MeteoBlueClient};
use crate::meteoswiss::{self, MeteoSwissClient};
use crate::openmeteo::{self, OpenMeteoClient};
use crate::pirate::{PirateClient, UpstreamError};

pub const MAX_PAST_DAYS: u32 = 30;
const FORECAST_TTL: Duration = Duration::from_secs(600);
const GEOCODE_TTL: Duration = Duration::from_secs(60 * 60 * 24);
const SECS_PER_DAY: i64 = 86_400;
const UNITS: [&str; 5] = ["si", "us", "ca", "uk", "uk2"];
const PROVIDERS: [&str; 4] = ["openmeteo", "pirateweather", "meteoblue", "meteoswiss"];
/// Model family names accepted by Pirate Weather's exclude parameter.
const MODELS: [&str; 12] = [
    "hrrr",
    "nbm",
    "gefs",
    "gfs",
    "rtma_ru",
    "ecmwf_ifs",
    "dwd_mosmix",
    "ecmwf_aifs",
    "aigefs",
    "aigfs",
    "raqdps",
    "silam",
];

#[derive(Clone)]
pub struct AppState {
    client: PirateClient,
    om: OpenMeteoClient,
    mb: MeteoBlueClient,
    ms: MeteoSwissClient,
    cache: Arc<Cache>,
}

impl AppState {
    pub fn new(
        client: PirateClient,
        om: OpenMeteoClient,
        mb: MeteoBlueClient,
        ms: MeteoSwissClient,
        cache: Arc<Cache>,
    ) -> AppState {
        AppState {
            client,
            om,
            mb,
            ms,
            cache,
        }
    }
}

#[derive(Deserialize)]
pub struct WeatherQuery {
    lat: f64,
    lon: f64,
    past_days: Option<u32>,
    units: Option<String>,
    lang: Option<String>,
    exclude: Option<String>,
    aimodels: Option<bool>,
    provider: Option<String>,
}
#[derive(Deserialize)]
pub struct GeoQuery {
    q: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
    lang: Option<String>,
}

fn bad_request(msg: &str) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg })))
}

fn upstream_failure(err: &UpstreamError) -> (StatusCode, Json<Value>) {
    // Deliberately generic: upstream error text may contain request URLs with
    // the API key. Full details are logged server-side by the caller.
    let (status, msg) = match err.status() {
        Some(StatusCode::TOO_MANY_REQUESTS) => (
            StatusCode::TOO_MANY_REQUESTS,
            "weather provider rate limit reached; retry shortly",
        ),
        Some(StatusCode::FORBIDDEN) => (
            StatusCode::BAD_GATEWAY,
            "weather provider rejected the request (check API key and quota)",
        ),
        _ => (StatusCode::BAD_GATEWAY, "weather provider unavailable"),
    };
    (status, Json(json!({ "error": msg })))
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before 1970")
        .as_secs() as i64
}

/// One timemachine timestamp per day: today at the current instant, earlier
/// days at location-local noon so day boundaries are unambiguous. The offset
/// from the forecast response is used for past days; across a DST transition
/// this can be one hour off, which never changes which local day noon lands in.
pub fn day_timestamps(now_utc: i64, offset_hours: f64, past_days: u32) -> Vec<(u32, i64)> {
    let offset_secs = (offset_hours * 3600.0).round() as i64;
    let local = now_utc + offset_secs;
    let local_midnight = local.div_euclid(SECS_PER_DAY) * SECS_PER_DAY;
    (0..=past_days)
        .map(|ago| {
            let ts = if ago == 0 {
                now_utc
            } else {
                local_midnight + SECS_PER_DAY / 2 - offset_secs - i64::from(ago) * SECS_PER_DAY
            };
            (ago, ts)
        })
        .collect()
}

async fn weather(State(state): State<AppState>, Query(q): Query<WeatherQuery>) -> Response {
    let past_days = q.past_days.unwrap_or(4).min(MAX_PAST_DAYS);
    let units = q.units.unwrap_or_else(|| "si".to_string());
    let lang = q.lang.unwrap_or_else(|| "en".to_string());
    let provider = q.provider.unwrap_or_else(|| "openmeteo".to_string());
    if !(-90.0..=90.0).contains(&q.lat) {
        return bad_request("lat must be in [-90, 90]").into_response();
    }
    let lon = if q.lon > 180.0 { q.lon - 360.0 } else { q.lon };
    if !(-180.0..=180.0).contains(&lon) {
        return bad_request("lon must be in [-180, 180] (or 0..360)").into_response();
    }
    if !UNITS.contains(&units.as_str()) {
        return bad_request("units must be one of si, us, ca, uk, uk2").into_response();
    }
    if !lang.chars().all(|c| c.is_ascii_lowercase() || c == '-')
        || lang.is_empty()
        || lang.len() > 12
    {
        return bad_request("lang must be a short language code").into_response();
    }
    if !PROVIDERS.contains(&provider.as_str()) {
        return bad_request(
            "provider must be one of openmeteo, pirateweather, meteoblue, meteoswiss",
        )
        .into_response();
    }

    let exclude = q.exclude.unwrap_or_default();
    for m in exclude.split(',').filter(|m| !m.is_empty()) {
        if !MODELS.contains(&m) {
            return bad_request(&format!(
                "exclude entries must be one of: {}",
                MODELS.join(", ")
            ))
            .into_response();
        }
    }
    let aimodels = q.aimodels.unwrap_or(false);
    let model_variant = format!("{exclude}+{aimodels}");

    let coords = format!("{:.3},{:.3}", q.lat, lon);
    let weather_key = format!("wx:{provider}:{coords}:{units}:{lang}:{past_days}:{model_variant}");
    if let Some(cached) = state.cache.get(&weather_key) {
        return ([(CACHE_CONTROL, "no-store")], Json(cached)).into_response();
    }

    // Provider branches converge on one Dark Sky-shaped document, then share
    // the cache insert and response headers below.
    let merged = if provider == "openmeteo" {
        // One call covers forecast + past days + cloud layers + nowcast.
        match state.om.forecast(q.lat, lon, past_days, &units).await {
            Ok(v) => {
                let doc = openmeteo::to_dark_sky(&v, &units);
                merge::merge(&doc, &[], vec![])
            }
            Err(e) => {
                tracing::error!(error = %e, "open-meteo request failed");
                return upstream_failure(&e).into_response();
            }
        }
    } else if provider == "meteoblue" {
        // meteoblue backbone + open-meteo fill, fetched concurrently.
        if !state.mb.has_key() {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": "meteoblue provider selected but METEOBLUE_API_KEY is not configured on the server"
                })),
            )
                .into_response();
        }
        let mb_client = state.mb.clone();
        let om_client = state.om.clone();
        let om_units = units.clone();
        let (mb_result, om_result) = tokio::join!(
            mb_client.forecast(q.lat, lon, past_days),
            om_client.forecast(q.lat, lon, past_days, &om_units),
        );
        let mb_doc = match mb_result {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(error = %e, "meteoblue request failed");
                return upstream_failure(&e).into_response();
            }
        };
        let mut warnings: Vec<String> = Vec::new();
        let om_doc = match om_result {
            Ok(v) => openmeteo::to_dark_sky(&v, &units),
            Err(e) => {
                tracing::warn!(error = %e, "open-meteo fill failed for meteoblue provider");
                warnings.push(
                    "cloud layers, gusts, and sun times unavailable (Open-Meteo fill failed)"
                        .to_string(),
                );
                // Degrade to a meteoblue-only document: synthesize an empty
                // host doc so merge() still produces a usable shape.
                openmeteo::to_dark_sky(&json!({}), &units)
            }
        };
        let doc = meteoblue::merge(&mb_doc, &om_doc, &units);
        merge::merge(&doc, &[], warnings)
    } else if provider == "meteoswiss" {
        // MeteoSwiss point forecast (keyless, CC-BY) + Open-Meteo fill,
        // fetched concurrently. MeteoSwiss covers Switzerland only; outside
        // coverage meteoswiss::merge degrades to the Open-Meteo document.
        let ms_client = state.ms.clone();
        let om_client = state.om.clone();
        let om_units = units.clone();
        let (ms_result, om_result) = tokio::join!(
            ms_client.forecast(q.lat, lon),
            om_client.forecast(q.lat, lon, past_days, &om_units),
        );
        let om_doc = match om_result {
            Ok(v) => openmeteo::to_dark_sky(&v, &units),
            Err(e) => {
                tracing::error!(error = %e, "open-meteo request failed for meteoswiss provider");
                return upstream_failure(&e).into_response();
            }
        };
        let ms_doc = match ms_result {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "meteoswiss request failed; degrading to open-meteo");
                json!({})
            }
        };
        let doc = meteoswiss::merge(&ms_doc, &om_doc, &units);
        // meteoswiss::merge may have added an out-of-coverage warning into
        // doc.meta.warnings; merge::merge overwrites meta, so carry them over.
        let warnings: Vec<String> = doc
            .get("meta")
            .and_then(|m| m.get("warnings"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|w| w.as_str().map(str::to_string))
            .collect();
        merge::merge(&doc, &[], warnings)
    } else {
        if !state.client.has_key() {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": "pirateweather provider selected but PIRATE_WEATHER_API_KEY is not configured on the server"
                })),
            )
                .into_response();
        }
        let req = PirateFetch {
            past_days,
            units: &units,
            lang: &lang,
            exclude: &exclude,
            aimodels,
            coords: &coords,
        };
        match fetch_pirate(&state, q.lat, lon, &req).await {
            Ok(doc) => doc,
            Err(e) => return (*e).into_response(),
        }
    };
    state
        .cache
        .insert(weather_key, merged.clone(), Some(FORECAST_TTL));
    ([(CACHE_CONTROL, "no-store")], Json(merged)).into_response()
}

/// Request-scoped parameters for the Pirate Weather path, grouped so
/// fetch_pirate stays readable (clippy's too-many-arguments threshold).
struct PirateFetch<'a> {
    past_days: u32,
    units: &'a str,
    lang: &'a str,
    exclude: &'a str,
    aimodels: bool,
    coords: &'a str,
}

/// Pirate path: forecast + timemachine fan-out for past days + Open-Meteo
/// cloud layers, merged into one document. Fatal failures map to the same
/// upstream error response as before; non-fatal partial failures become
/// meta.warnings.
async fn fetch_pirate(
    state: &AppState,
    lat: f64,
    lon: f64,
    req: &PirateFetch<'_>,
) -> Result<Value, Box<Response>> {
    let PirateFetch {
        past_days,
        units,
        lang,
        exclude,
        aimodels,
        coords,
    } = *req;
    // Forecast (fatal) and cloud layers (non-fatal) run concurrently.
    let fc_client = state.client.clone();
    let om_client = state.client.clone();
    let (fc_units, fc_lang) = (units.to_string(), lang.to_string());
    let fc_future = fc_client.forecast(lat, lon, &fc_units, &fc_lang, exclude, aimodels);
    let om_future = om_client.cloud_layers(lat, lon, past_days);
    let (forecast_result, om_result) = tokio::join!(fc_future, om_future);

    let forecast = match forecast_result {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, "forecast request failed");
            return Err(Box::new(upstream_failure(&e).into_response()));
        }
    };

    let mut warnings: Vec<String> = Vec::new();
    let cloud_layers: Option<Value> = match om_result {
        Ok(v) => normalize_cloud_layers(&v),
        Err(e) => {
            tracing::warn!(error = %e, "open-meteo cloud layers failed");
            warnings.push("cloud layer data unavailable".to_string());
            None
        }
    };

    let mut past: Vec<Value> = Vec::new();
    if past_days >= 1 {
        let offset = forecast
            .get("offset")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let mut set = JoinSet::new();
        for (ago, ts) in day_timestamps(unix_now(), offset, past_days) {
            let client = state.client.clone();
            let cache = state.cache.clone();
            let key = format!("tm:{coords}:{ts}:{units}:{lang}");
            let units = units.to_string();
            let lang = lang.to_string();
            set.spawn(async move {
                if let Some(v) = cache.get(&key) {
                    return Ok((ago, v));
                }
                let v = client.timemachine(lat, lon, ts, &units, &lang).await?;
                // Days before today are settled archive data: cache permanently.
                let ttl = if ago == 0 { Some(FORECAST_TTL) } else { None };
                cache.insert(key, v.clone(), ttl);
                Ok::<(u32, Value), UpstreamError>((ago, v))
            });
        }
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok(Ok((_, v))) => past.push(v),
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "timemachine day failed");
                    warnings.push("one past day failed to load".to_string());
                }
                Err(e) => {
                    tracing::error!(error = %e, "timemachine task failed");
                    warnings.push("one past day failed to load".to_string());
                }
            }
        }
    }

    let mut merged = merge::merge(&forecast, &past, warnings);
    if let Some(cl) = cloud_layers {
        let root = merged
            .as_object_mut()
            .expect("merged response is an object");
        root.insert("cloudLayers".to_string(), cl);
    }
    Ok(merged)
}

async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        // Lets a deploy verify which version is actually serving.
        "version": env!("CARGO_PKG_VERSION"),
        "commit": env!("BUILD_COMMIT"),
        "built": env!("BUILD_DATE"),
    }))
}

#[cfg(test)]
mod health_meta_tests {
    #[test]
    fn health_metadata_format() {
        // build.rs emits "YYYY-MM-DD HH:MMZ".
        let built = env!("BUILD_DATE");
        assert_eq!(built.len(), 17, "unexpected build date format: {built:?}");
        assert!(built.ends_with('Z'));
        let (date, time) = built.split_at(10);
        assert_eq!(&date[4..5], "-");
        assert!(time.trim_end_matches('Z').contains(':'));
        // Version and commit are non-empty.
        assert!(!env!("CARGO_PKG_VERSION").is_empty());
        assert!(!env!("BUILD_COMMIT").is_empty());
    }
}

async fn geocode(State(state): State<AppState>, Query(q): Query<GeoQuery>) -> Response {
    let Some(qs) = q.q.as_deref() else {
        return bad_request("q is required").into_response();
    };
    let lang = q.lang.unwrap_or_else(|| "en".to_string());
    if qs.trim().len() < 2 || qs.len() > 100 {
        return bad_request("q must be 2..100 characters").into_response();
    }
    let key = format!("geo:{}:{}", lang, qs.trim().to_lowercase());
    let body = match state.cache.get(&key) {
        Some(v) => v,
        None => match state.client.geocode(qs.trim(), &lang).await {
            Ok(v) => {
                let results: Vec<Value> = v
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|r| {
                                Some(json!({
                                    "name": r.get("display_name")?,
                                    "lat": r.get("lat")?.as_str()?.parse::<f64>().ok()?,
                                    "lon": r.get("lon")?.as_str()?.parse::<f64>().ok()?,
                                }))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let v = json!(results);
                state.cache.insert(key, v.clone(), Some(GEOCODE_TTL));
                v
            }
            Err(e) => {
                tracing::warn!(error = %e, "geocode request failed");
                return upstream_failure(&e).into_response();
            }
        },
    };
    Json(body).into_response()
}

async fn reverse(State(state): State<AppState>, Query(q): Query<GeoQuery>) -> Response {
    let (Some(lat), Some(lon)) = (q.lat, q.lon) else {
        return bad_request("lat and lon are required").into_response();
    };
    let lang = q.lang.unwrap_or_else(|| "en".to_string());
    let key = format!("rev:{lang}:{lat:.3},{lon:.3}");
    let body = match state.cache.get(&key) {
        Some(v) => v,
        None => match state.client.reverse(lat, lon, &lang).await {
            Ok(v) => {
                let name = v
                    .get("display_name")
                    .cloned()
                    .unwrap_or_else(|| json!(format!("{lat:.3}, {lon:.3}")));
                let v = json!({ "name": name, "lat": lat, "lon": lon });
                state.cache.insert(key, v.clone(), Some(GEOCODE_TTL));
                v
            }
            Err(e) => {
                tracing::warn!(error = %e, "reverse geocode failed");
                return upstream_failure(&e).into_response();
            }
        },
    };
    Json(body).into_response()
}

/// Hashed Vite assets are immutable; entry HTML and API responses are not.
async fn cache_headers(req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let mut resp = next.run(req).await;
    let value = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else if path.starts_with("/api/") {
        "no-store"
    } else {
        "no-cache"
    };
    resp.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(value));
    resp
}

pub fn router(state: AppState, static_dir: &std::path::Path) -> Router {
    let index = static_dir.join("index.html");
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/weather", get(weather))
        .route("/api/geocode", get(geocode))
        .route("/api/reverse", get(reverse))
        .with_state(state);
    Router::new()
        .merge(api)
        .fallback_service(ServeDir::new(static_dir).fallback(ServeFile::new(index)))
        .layer(middleware::from_fn(cache_headers))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
}

/// Reshape the Open-Meteo hourly block into compact parallel arrays. This is
/// our own API surface, not an upstream passthrough, so it uses short names.
fn normalize_cloud_layers(v: &Value) -> Option<Value> {
    let h = v.get("hourly")?;
    let time = h.get("time")?.clone();
    let low = h.get("cloudcover_low")?.clone();
    let mid = h.get("cloudcover_mid")?.clone();
    let high = h.get("cloudcover_high")?.clone();
    Some(json!({ "time": time, "low": low, "mid": mid, "high": high }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_timestamps_cover_past_days_and_today() {
        // 2024-06-10 15:00 UTC at UTC+2 -> local 17:00.
        let now = 1_718_031_600;
        let stamps = day_timestamps(now, 2.0, 2);
        assert_eq!(stamps.len(), 3);
        assert_eq!(stamps[0], (0, now));
        // Ago=1 is June 9 at local noon: 10:00 UTC at UTC+2.
        assert_eq!(stamps[1].1, 1_717_927_200);
    }

    #[test]
    fn error_mapping_hides_upstream_detail() {
        for (given, want) in [
            (
                Some(StatusCode::TOO_MANY_REQUESTS),
                StatusCode::TOO_MANY_REQUESTS,
            ),
            (Some(StatusCode::FORBIDDEN), StatusCode::BAD_GATEWAY),
            (
                Some(StatusCode::INTERNAL_SERVER_ERROR),
                StatusCode::BAD_GATEWAY,
            ),
            (None, StatusCode::BAD_GATEWAY),
        ] {
            let err = match given {
                Some(s) => UpstreamError::Status {
                    status: s,
                    service: "svc",
                    detail: "x".into(),
                },
                None => UpstreamError::Network {
                    service: "svc",
                    detail: "x".into(),
                },
            };
            let (status, _) = upstream_failure(&err);
            assert_eq!(status, want);
        }
    }
}
