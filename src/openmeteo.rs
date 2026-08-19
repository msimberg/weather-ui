// Open-Meteo provider: one forecast call per location, translated into the
// Dark Sky-shaped document the rest of the app consumes. Pirate Weather and
// Open-Meteo produce the same shape, so the merge layer and the frontend
// cannot tell them apart; adding a third provider means adding one file
// like this.
//
// Verified API facts (2026-08): with timeformat=unixtime, hourly.time and
// daily.time are true UTC epoch seconds (daily.time is the local-midnight
// epoch, matching Dark Sky); timezone=auto returns the IANA name; hourly
// blocks accept past_days back to ~3 months; cloud-cover layers, the
// 15-minute nowcast block, and the current condition block all ride the
// same request, so one call replaces Pirate's forecast +
// N timemachine fan-out + separate cloud-layer call.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::pirate::UpstreamError;

const FORECAST_BASE: &str = "https://api.open-meteo.com/v1/forecast";

const HOURLY_VARS: &str = concat!(
    "temperature_2m,apparent_temperature,relative_humidity_2m,dewpoint_2m,",
    "precipitation_probability,precipitation,rain,showers,snowfall,weather_code,",
    "pressure_msl,cloudcover,cloudcover_low,cloudcover_mid,cloudcover_high,",
    "visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,is_day"
);

const DAILY_VARS: &str = concat!(
    "weather_code,temperature_2m_max,temperature_2m_min,",
    "apparent_temperature_max,apparent_temperature_min,sunrise,sunset,",
    "moon_phase,uv_index_max,precipitation_sum,precipitation_probability_max,",
    "wind_speed_10m_max,wind_gusts_10m_max"
);

const CURRENT_VARS: &str = concat!(
    "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,",
    "precipitation,weather_code,cloudcover,pressure_msl,",
    "wind_speed_10m,wind_direction_10m,wind_gusts_10m"
);

#[derive(Clone)]
pub struct OpenMeteoClient {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
}

impl OpenMeteoClient {
    pub fn new(user_agent: String) -> OpenMeteoClient {
        let http = reqwest::Client::builder()
            .user_agent(user_agent)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client construction failed");
        OpenMeteoClient { inner: Arc::new(Inner { http }) }
    }

    /// Fetch the complete forecast for a point: hourly, daily, current,
    /// 15-minute nowcast, and cloud layers in one response. Past days ride
    /// in the same block via past_days, so there is no timemachine fan-out
    /// as on the Pirate path.
    pub async fn forecast(
        &self,
        lat: f64,
        lon: f64,
        past_days: u32,
        units: &str,
    ) -> Result<Value, UpstreamError> {
        let (temperature_unit, wind_speed_unit, precipitation_unit) = om_units(units);
        let url = format!(
            "{FORECAST_BASE}?latitude={lat:.3}&longitude={lon:.3}\
             &timezone=auto&timeformat=unixtime\
             &past_days={past_days}&forecast_days=8\
             &hourly={HOURLY_VARS}&daily={DAILY_VARS}&current={CURRENT_VARS}\
             &minutely_15=precipitation,precipitation_probability\
             &temperature_unit={temperature_unit}\
             &wind_speed_unit={wind_speed_unit}\
             &precipitation_unit={precipitation_unit}"
        );
        let resp = self.inner.http.get(&url).send().await.map_err(|e| UpstreamError::Network {
            service: "open-meteo",
            detail: e.to_string(),
        })?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let excerpt: String = body.chars().take(200).collect();
            return Err(UpstreamError::Status { status, service: "open-meteo", detail: excerpt });
        }
        resp.json::<Value>().await.map_err(|e| UpstreamError::Network {
            service: "open-meteo",
            detail: e.to_string(),
        })
    }
}

/// Open-Meteo unit triple per Dark Sky units value. si is celsius + m/s
/// + mm; ca swaps wind to km/h; us goes imperial; uk/uk2 keep celsius + mm
/// but use mph wind. Visibility stays meters upstream and is converted
/// in the translator.
fn om_units(units: &str) -> (&'static str, &'static str, &'static str) {
    match units {
        "us" => ("fahrenheit", "mph", "inch"),
        "ca" => ("celsius", "kmh", "mm"),
        "uk" | "uk2" => ("celsius", "mph", "mm"),
        _ => ("celsius", "ms", "mm"),
    }
}

/// Visibility arrives in meters; Dark Sky/Pirate serve km (si/ca) or
/// miles (us/uk/uk2).
fn convert_visibility(meters: f64, units: &str) -> f64 {
    match units {
        "us" | "uk" | "uk2" => meters / 1609.344,
        _ => meters / 1000.0,
    }
}

/// precipitation_sum arrives in mm (inch for us); Dark Sky
/// precipAccumulation is cm (si/ca/uk/uk2) or inches (us). The frontend
/// displays `accum * 10` as mm for non-us units.
fn convert_accumulation(sum: f64, units: &str) -> f64 {
    if units == "us" {
        sum
    } else {
        sum / 10.0
    }
}

/// WMO weather code -> (summary, icon-day, icon-night, precip-type).
/// Icon names follow the Dark Sky vocabulary so the frontend icon set and
/// tooltips need no changes.
fn weather_code(code: i64) -> (&'static str, &'static str, &'static str, Option<&'static str>) {
    match code {
        0 | 1 => ("Clear sky", "clear-day", "clear-night", None),
        2 => ("Partly cloudy", "partly-cloudy-day", "partly-cloudy-night", None),
        3 => ("Overcast", "cloudy", "cloudy", None),
        45 | 48 => ("Fog", "fog", "fog", None),
        51 => ("Light drizzle", "drizzle", "drizzle", Some("rain")),
        53 => ("Drizzle", "drizzle", "drizzle", Some("rain")),
        55 => ("Dense drizzle", "drizzle", "drizzle", Some("rain")),
        56 | 57 => ("Freezing drizzle", "sleet", "sleet", Some("sleet")),
        61 | 80 => ("Light rain", "rain", "rain", Some("rain")),
        63 | 81 => ("Rain", "rain", "rain", Some("rain")),
        65 | 82 => ("Heavy rain", "rain", "rain", Some("rain")),
        66 | 67 => ("Freezing rain", "sleet", "sleet", Some("sleet")),
        71 | 77 | 85 => ("Light snow", "snow", "snow", Some("snow")),
        73 | 86 => ("Snow", "snow", "snow", Some("snow")),
        75 => ("Heavy snow", "snow", "snow", Some("snow")),
        95 => ("Thunderstorm", "thunderstorm", "thunderstorm", Some("rain")),
        96 | 99 => ("Thunderstorm with hail", "thunderstorm", "thunderstorm", Some("hail")),
        _ => ("Unknown", "cloudy", "cloudy", None),
    }
}

fn f64_at(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// Splice an Open-Meteo parallel-array block ({time: [...], var: [...]})
/// into per-slot objects, skipping nulls. Each variable is handed to
/// map_slot which performs the Dark Sky rename and any unit conversion.
fn splice_block(
    block: &Value,
    keys: &[&str],
    units: &str,
    map_slot: fn(&mut Map<String, Value>, &str, f64, &str, bool),
    hourly_context: Option<&Value>,
) -> Vec<Value> {
    let times = match block.get("time").and_then(Value::as_array) {
        Some(t) => t,
        None => return Vec::new(),
    };
    let arrays: Vec<(&str, &Vec<Value>)> = keys
        .iter()
        .filter_map(|k| Some((*k, block.get(*k).and_then(Value::as_array)?)))
        .collect();
    let mut out = Vec::with_capacity(times.len());
    for (i, t) in times.iter().enumerate() {
        let mut slot = Map::new();
        slot.insert("time".to_string(), t.clone());
        let is_day = match hourly_context {
            Some(h) => h
                .get("is_day")
                .and_then(Value::as_array)
                .and_then(|a| a.get(i))
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                > 0.0,
            None => true, // daily icons are always the day variant
        };
        for (k, arr) in &arrays {
            if let Some(f) = arr.get(i).and_then(f64_at) {
                map_slot(&mut slot, k, f, units, is_day);
            }
        }
        out.push(Value::Object(slot));
    }
    out
}

const HOURLY_KEYS: &[&str] = &[
    "temperature_2m", "apparent_temperature", "relative_humidity_2m", "dewpoint_2m",
    "precipitation_probability", "precipitation", "rain", "showers", "snowfall",
    "weather_code", "pressure_msl", "cloudcover", "cloudcover_low", "cloudcover_mid",
    "cloudcover_high", "visibility", "wind_speed_10m", "wind_direction_10m",
    "wind_gusts_10m", "uv_index", "is_day",
];

fn map_hour_slot(slot: &mut Map<String, Value>, k: &str, f: f64, units: &str, is_day: bool) {
    match k {
        "temperature_2m" => slot.insert("temperature".to_string(), json!(f)),
        "apparent_temperature" => slot.insert("apparentTemperature".to_string(), json!(f)),
        "relative_humidity_2m" => slot.insert("humidity".to_string(), json!(f / 100.0)),
        "dewpoint_2m" => slot.insert("dewPoint".to_string(), json!(f)),
        "precipitation_probability" => slot.insert("precipProbability".to_string(), json!(f / 100.0)),
        "precipitation" => {
            slot.insert("precipIntensity".to_string(), json!(f));
            slot.insert("liquidAccumulation".to_string(), json!(f))
        }
        "rain" | "showers" => {
            if f > 0.0 {
                let prev = slot.get("rainIntensity").and_then(Value::as_f64).unwrap_or(0.0);
                slot.insert("rainIntensity".to_string(), json!(prev + f));
            }
            return;
        }
        "snowfall" => {
            slot.insert("snowIntensity".to_string(), json!(f));
            slot.insert("snowAccumulation".to_string(), json!(f))
        }
        "weather_code" => {
            let (summary, day, night, ptype) = weather_code(f as i64);
            slot.insert("summary".to_string(), json!(summary));
            slot.insert("icon".to_string(), json!(if is_day { day } else { night }));
            if !slot.contains_key("precipType") {
                if let Some(p) = ptype {
                    slot.insert("precipType".to_string(), json!(p));
                }
            }
            return;
        }
        "pressure_msl" => slot.insert("pressure".to_string(), json!(f)),
        "cloudcover" => slot.insert("cloudCover".to_string(), json!(f / 100.0)),
        "visibility" => slot.insert("visibility".to_string(), json!(convert_visibility(f, units))),
        "wind_speed_10m" => slot.insert("windSpeed".to_string(), json!(f)),
        "wind_direction_10m" => slot.insert("windBearing".to_string(), json!(f)),
        "wind_gusts_10m" => slot.insert("windGust".to_string(), json!(f)),
        "uv_index" => slot.insert("uvIndex".to_string(), json!(f)),
        _ => return,
    };
}

const DAILY_KEYS: &[&str] = &[
    "weather_code", "temperature_2m_max", "temperature_2m_min",
    "apparent_temperature_max", "apparent_temperature_min", "sunrise", "sunset",
    "moon_phase", "uv_index_max", "precipitation_sum", "precipitation_probability_max",
    "wind_speed_10m_max", "wind_gusts_10m_max",
];

fn map_day_slot(slot: &mut Map<String, Value>, k: &str, f: f64, units: &str, _is_day: bool) {
    match k {
        "weather_code" => {
            let (summary, day, _night, ptype) = weather_code(f as i64);
            slot.insert("summary".to_string(), json!(summary));
            slot.insert("icon".to_string(), json!(day));
            if let Some(p) = ptype {
                slot.insert("precipType".to_string(), json!(p));
            }
            return;
        }
        "temperature_2m_max" => {
            slot.insert("temperatureHigh".to_string(), json!(f));
            slot.insert("temperatureMax".to_string(), json!(f))
        }
        "temperature_2m_min" => {
            slot.insert("temperatureLow".to_string(), json!(f));
            slot.insert("temperatureMin".to_string(), json!(f))
        }
        "apparent_temperature_max" => slot.insert("apparentTemperatureHigh".to_string(), json!(f)),
        "apparent_temperature_min" => slot.insert("apparentTemperatureLow".to_string(), json!(f)),
        // Times stay integers, matching Dark Sky convention.
        "sunrise" => slot.insert("sunriseTime".to_string(), json!(f as i64)),
        "sunset" => slot.insert("sunsetTime".to_string(), json!(f as i64)),
        "moon_phase" => slot.insert("moonPhase".to_string(), json!(f)),
        "uv_index_max" => slot.insert("uvIndexMax".to_string(), json!(f)),
        "precipitation_sum" => {
            slot.insert("precipAccumulation".to_string(), json!(convert_accumulation(f, units)))
        }
        "precipitation_probability_max" => {
            slot.insert("precipProbability".to_string(), json!(f / 100.0))
        }
        "wind_speed_10m_max" => slot.insert("windSpeed".to_string(), json!(f)),
        "wind_gusts_10m_max" => slot.insert("windGust".to_string(), json!(f)),
        _ => return,
    };
}

/// `currently` is synthesized from the hourly slot containing current.time
/// (Open-Meteo's sparse `current` block lacks dew point, uv, visibility),
/// with fresher values from the current block overridden on top.
fn synthesize_currently(om: &Value, hourly: &[Value]) -> Value {
    let current = om.get("current").cloned().unwrap_or_else(|| json!({}));
    let now_t = current.get("time").and_then(Value::as_f64).unwrap_or(0.0);
    let mut base = hourly
        .iter()
        .filter(|h| h.get("time").and_then(Value::as_f64).unwrap_or(0.0) <= now_t)
        .last()
        .cloned()
        .unwrap_or_else(|| json!({}));
    let obj = base.as_object_mut().expect("hour point is an object");
    if now_t > 0.0 {
        obj.insert("time".to_string(), json!(now_t as i64));
    }
    let mut override_num = |src: &str, dst: &str, scale: f64| {
        if let Some(f) = current.get(src).and_then(Value::as_f64) {
            obj.insert(dst.to_string(), json!(f * scale));
        }
    };
    override_num("temperature_2m", "temperature", 1.0);
    override_num("apparent_temperature", "apparentTemperature", 1.0);
    override_num("relative_humidity_2m", "humidity", 0.01);
    override_num("precipitation", "precipIntensity", 1.0);
    override_num("cloudcover", "cloudCover", 0.01);
    override_num("pressure_msl", "pressure", 1.0);
    override_num("wind_speed_10m", "windSpeed", 1.0);
    override_num("wind_direction_10m", "windBearing", 1.0);
    override_num("wind_gusts_10m", "windGust", 1.0);
    if let Some(code) = current.get("weather_code").and_then(Value::as_i64) {
        let (summary, day, night, ptype) = weather_code(code);
        let is_day = current.get("is_day").and_then(Value::as_f64).unwrap_or(1.0) > 0.0;
        obj.insert("summary".to_string(), json!(summary));
        obj.insert("icon".to_string(), json!(if is_day { day } else { night }));
        if let Some(p) = ptype {
            obj.insert("precipType".to_string(), json!(p));
        }
    }
    base
}

/// Collapse the 15-minute nowcast block into Dark Sky minutely points.
/// Pirate's minutely covers exactly [now, now+60min]; Open-Meteo returns the
/// whole forecast range, so it is trimmed to a short window around now.
/// Without a trim the frontend's sample picker would treat every hover as
/// minute-level (any instant is within 15 min of some slot) and hour-level
/// tooltip detail would be unreachable. 15-minute granularity is coarser
/// than Pirate's true minutes but is what the API provides.
fn to_minutely(om: &Value) -> Value {
    let block = om.get("minutely_15").cloned().unwrap_or_else(|| json!({}));
    let now_t = om
        .get("current")
        .and_then(|c| c.get("time"))
        .and_then(f64_at)
        .unwrap_or(0.0);
    // Keep [now, now+2h]: the current slot plus eight 15-minute nowcasts.
    let lo = now_t;
    let hi = now_t + 2.0 * 3600.0;
    let times = block.get("time").and_then(Value::as_array).cloned().unwrap_or_default();
    let precip = block.get("precipitation").and_then(Value::as_array).cloned().unwrap_or_default();
    let prob = block
        .get("precipitation_probability")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let data: Vec<Value> = times
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            let tt = f64_at(t).unwrap_or(0.0);
            tt >= lo && tt <= hi
        })
        .map(|(i, t)| {
            let mut slot = Map::new();
            slot.insert("time".to_string(), t.clone());
            if let Some(p) = precip.get(i).and_then(f64_at) {
                // 15-min slots carry accumulation, not rate: scale to a
                // per-hour rate so the bars are comparable to the hourly band.
                slot.insert("precipIntensity".to_string(), json!(p * 4.0));
            }
            if let Some(q) = prob.get(i).and_then(f64_at) {
                slot.insert("precipProbability".to_string(), json!(q / 100.0));
            }
            Value::Object(slot)
        })
        .collect();
    json!({ "data": data })
}

/// Extract the cloud-cover layer arrays for the frontend's CloudLayers
/// companion block, in the same shape as routes::normalize_cloud_layers.
fn cloud_layers(hourly: &Value) -> Option<Value> {
    let time = hourly.get("time")?.clone();
    let low = hourly.get("cloudcover_low")?.clone();
    let mid = hourly.get("cloudcover_mid")?.clone();
    let high = hourly.get("cloudcover_high")?.clone();
    Some(json!({ "time": time, "low": low, "mid": mid, "high": high }))
}

/// Derive the Dark Sky daily fields Open-Meteo lacks from the hourly data:
/// temperatureHighTime/LowTime (frontend places the H/L dots there) and
/// precipIntensityMax (scales the precip bars). Hours are bucketed by the
/// daily.time local-midnight boundaries, same as Dark Sky.
fn enrich_daily(daily: &mut [Value], hourly: &[Value]) {
    let bounds: Vec<i64> = daily
        .iter()
        .filter_map(|d| d.get("time").and_then(Value::as_i64))
        .collect();
    for (i, day) in daily.iter_mut().enumerate() {
        let start = bounds[i];
        let end = bounds.get(i + 1).copied().unwrap_or(start + 86_400);
        let mut max_t: Option<(f64, i64)> = None;
        let mut min_t: Option<(f64, i64)> = None;
        let mut max_p = 0.0f64;
        for h in hourly {
            let t = match h.get("time").and_then(Value::as_i64) {
                Some(t) => t,
                None => continue,
            };
            if t < start || t >= end {
                continue;
            }
            if let Some(temp) = h.get("temperature").and_then(f64_at) {
                if max_t.is_none_or(|(m, _)| temp > m) {
                    max_t = Some((temp, t));
                }
                if min_t.is_none_or(|(m, _)| temp < m) {
                    min_t = Some((temp, t));
                }
            }
            if let Some(p) = h.get("precipIntensity").and_then(f64_at) {
                max_p = max_p.max(p);
            }
        }
        let day = day.as_object_mut().expect("day point is an object");
        if let Some((_, t)) = max_t {
            day.insert("temperatureHighTime".to_string(), json!(t));
        }
        if let Some((_, t)) = min_t {
            day.insert("temperatureLowTime".to_string(), json!(t));
        }
        if max_p > 0.0 {
            day.insert("precipIntensityMax".to_string(), json!(max_p));
        }
    }
}

/// Translate a raw Open-Meteo forecast response into the app's
/// Dark Sky-shaped document. Pure and unit-tested; malformed or missing
/// upstream fields degrade to absent keys, which the frontend tolerates
/// (every field is optional there).
pub fn to_dark_sky(om: &Value, units: &str) -> Value {
    let timezone = om.get("timezone").and_then(Value::as_str).unwrap_or("UTC");
    let offset = om.get("utc_offset_seconds").and_then(f64_at).unwrap_or(0.0) / 3600.0;
    let hourly_raw = om.get("hourly").cloned().unwrap_or_else(|| json!({}));
    let hourly_data = splice_block(&hourly_raw, HOURLY_KEYS, units, map_hour_slot, Some(&hourly_raw));
    let mut daily_data = splice_block(
        om.get("daily").unwrap_or(&Value::Null),
        DAILY_KEYS,
        units,
        map_day_slot,
        None,
    );
    enrich_daily(&mut daily_data, &hourly_data);
    let currently = synthesize_currently(om, &hourly_data);

    let mut out = json!({
        "latitude": om.get("latitude").and_then(f64_at).unwrap_or(0.0),
        "longitude": om.get("longitude").and_then(f64_at).unwrap_or(0.0),
        "timezone": timezone,
        "offset": offset,
        "currently": currently,
        "minutely": to_minutely(om),
        "hourly": { "data": hourly_data },
        "daily": { "data": daily_data },
        "flags": { "sources": ["open-meteo"], "units": units },
    });
    let root = out.as_object_mut().expect("document is an object");
    if let Some(elev) = om.get("elevation").and_then(f64_at) {
        root.insert("elevation".to_string(), json!(elev));
    }
    if let Some(cl) = cloud_layers(&hourly_raw) {
        root.insert("cloudLayers".to_string(), cl);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal fixture shaped like a verified 2026-08 Open-Meteo response.
    fn fixture() -> Value {
        json!({
            "latitude": 47.38, "longitude": 8.54,
            "utc_offset_seconds": 7200, "timezone": "Europe/Zurich",
            "elevation": 409.0,
            "hourly": {
                "time": [1787004000, 1787007600],
                "temperature_2m": [22.5, 23.1],
                "relative_humidity_2m": [60, 55],
                "precipitation_probability": [10, 20],
                "precipitation": [0.0, 1.2],
                "rain": [0.0, 1.2],
                "snowfall": [0.0, 0.0],
                "weather_code": [2, 61],
                "cloudcover": [25, 80],
                "cloudcover_low": [10, 60],
                "cloudcover_mid": [20, 70],
                "cloudcover_high": [5, 40],
                "visibility": [20000.0, 12000.0],
                "wind_speed_10m": [3.2, 4.1],
                "wind_direction_10m": [180, 220],
                "wind_gusts_10m": [6.0, 8.5],
                "uv_index": [3.5, 2.0],
                "is_day": [1, 1]
            },
            "daily": {
                "time": [1787004000],
                "weather_code": [61],
                "temperature_2m_max": [26.0],
                "temperature_2m_min": [15.0],
                "apparent_temperature_max": [27.0],
                "apparent_temperature_min": [14.0],
                "sunrise": [1787017577],
                "sunset": [1787068177],
                "moon_phase": [0.5],
                "uv_index_max": [6.0],
                "precipitation_sum": [3.4],
                "precipitation_probability_max": [80],
                "wind_speed_10m_max": [7.0],
                "wind_gusts_10m_max": [12.0]
            },
            "current": {
                "time": 1787007600, "temperature_2m": 23.4,
                "relative_humidity_2m": 52, "apparent_temperature": 24.0,
                "is_day": 1, "precipitation": 0.5, "weather_code": 61,
                "cloudcover": 75, "pressure_msl": 1015.0,
                "wind_speed_10m": 4.4, "wind_direction_10m": 230,
                "wind_gusts_10m": 9.0
            },
            "minutely_15": {
                "time": [1787007600, 1787008500, 1787017200],
                "precipitation": [0.0, 0.3, 0.4],
                "precipitation_probability": [10, 55, 99]
            }
        })
    }

    #[test]
    fn hourly_maps_dark_sky_fields() {
        let doc = to_dark_sky(&fixture(), "si");
        let hours = doc["hourly"]["data"].as_array().unwrap();
        assert_eq!(hours.len(), 2);
        let h = &hours[1];
        assert_eq!(h["temperature"], json!(23.1));
        assert_eq!(h["humidity"], json!(0.55));
        assert_eq!(h["precipProbability"], json!(0.2));
        assert_eq!(h["precipIntensity"], json!(1.2));
        assert_eq!(h["rainIntensity"], json!(1.2));
        assert_eq!(h["icon"], json!("rain"));
        assert_eq!(h["summary"], json!("Light rain"));
        assert_eq!(h["precipType"], json!("rain"));
        assert_eq!(h["cloudCover"], json!(0.8));
        assert_eq!(h["visibility"], json!(12.0)); // meters -> km for si
        assert_eq!(h["windSpeed"], json!(4.1));
        assert_eq!(h["windGust"], json!(8.5));
        assert_eq!(h["uvIndex"], json!(2.0));
    }

    #[test]
    fn night_hours_get_night_icons() {
        let mut f = fixture();
        f["hourly"]["is_day"] = json!([0, 0]);
        f["hourly"]["weather_code"] = json!([2, 2]);
        let doc = to_dark_sky(&f, "si");
        assert_eq!(doc["hourly"]["data"][0]["icon"], json!("partly-cloudy-night"));
    }

    #[test]
    fn us_units_convert_visibility_miles_and_accumulation_inches() {
        // fetch() asks upstream for fahrenheit/mph/inch when units=us, so the
        // fixture's metric values pretend to be imperial here; only the
        // translator-side conversions (visibility, accumulation) are tested.
        let doc = to_dark_sky(&fixture(), "us");
        let h = &doc["hourly"]["data"][1];
        let vis = h["visibility"].as_f64().unwrap();
        assert!((vis - 12000.0 / 1609.344).abs() < 1e-6);
        let d = &doc["daily"]["data"][0];
        assert_eq!(d["precipAccumulation"], json!(3.4)); // inches pass through
    }

    #[test]
    fn si_daily_accumulation_is_cm() {
        // Open-Meteo mm -> Dark Sky cm: 3.4 mm = 0.34 cm.
        let doc = to_dark_sky(&fixture(), "si");
        let d = &doc["daily"]["data"][0];
        let a = d["precipAccumulation"].as_f64().unwrap();
        assert!((a - 0.34).abs() < 1e-9, "got {a}");
        assert_eq!(d["temperatureHigh"], json!(26.0));
        assert_eq!(d["temperatureLow"], json!(15.0));
        assert_eq!(d["temperatureMax"], json!(26.0));
        assert_eq!(d["apparentTemperatureHigh"], json!(27.0));
        assert_eq!(d["sunriseTime"], json!(1787017577));
        assert_eq!(d["moonPhase"], json!(0.5));
        assert_eq!(d["uvIndexMax"], json!(6.0));
        assert_eq!(d["precipProbability"], json!(0.8));
        assert_eq!(d["icon"], json!("rain"));
    }

    #[test]
    fn daily_enrichment_from_hourly() {
        // The fixture's second hour is warmer and wetter, so the H/L dot
        // times and the precip max come out of the hourly pass.
        let doc = to_dark_sky(&fixture(), "si");
        let d = &doc["daily"]["data"][0];
        assert_eq!(d["temperatureHighTime"], json!(1787007600));
        assert_eq!(d["temperatureLowTime"], json!(1787004000));
        assert_eq!(d["precipIntensityMax"], json!(1.2));
    }

    #[test]
    fn timezone_and_offset_map_through() {
        let doc = to_dark_sky(&fixture(), "si");
        assert_eq!(doc["timezone"], json!("Europe/Zurich"));
        assert_eq!(doc["offset"], json!(2.0));
        assert_eq!(doc["elevation"], json!(409.0));
        assert_eq!(doc["flags"]["units"], json!("si"));
    }

    #[test]
    fn currently_uses_hour_base_with_current_overrides() {
        let doc = to_dark_sky(&fixture(), "si");
        let c = &doc["currently"];
        assert_eq!(c["time"], json!(1787007600));
        assert_eq!(c["temperature"], json!(23.4)); // from current block
        assert_eq!(c["humidity"], json!(0.52));
        assert_eq!(c["cloudCover"], json!(0.75));
        assert_eq!(c["icon"], json!("rain"));
        // uv and visibility survive from the hourly base slot.
        assert_eq!(c["uvIndex"], json!(2.0));
        assert_eq!(c["visibility"], json!(12.0));
    }

    #[test]
    fn minutely_slots_become_per_hour_rates() {
        let doc = to_dark_sky(&fixture(), "si");
        let m = doc["minutely"]["data"].as_array().unwrap();
        // Slots at now and now+15min survive; the now+2h40m slot is trimmed.
        assert_eq!(m.len(), 2);
        assert_eq!(m[1]["precipIntensity"], json!(1.2)); // 0.3/15min * 4
        assert_eq!(m[1]["precipProbability"], json!(0.55));
    }

    #[test]
    fn cloud_layers_ride_along() {
        let doc = to_dark_sky(&fixture(), "si");
        let cl = &doc["cloudLayers"];
        assert_eq!(cl["low"], json!([10, 60]));
        assert_eq!(cl["time"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn missing_blocks_degrade_gracefully() {
        let doc = to_dark_sky(&json!({"latitude": 1.0}), "si");
        assert_eq!(doc["hourly"]["data"], json!([]));
        assert_eq!(doc["daily"]["data"], json!([]));
        assert_eq!(doc["currently"], json!({}));
        assert!(doc.get("cloudLayers").is_none());
    }

    #[test]
    fn day_part_icons_for_each_code_family() {
        for (code, day_icon, night_icon) in [
            (0, "clear-day", "clear-night"),
            (3, "cloudy", "cloudy"),
            (45, "fog", "fog"),
            (56, "sleet", "sleet"),
            (65, "rain", "rain"),
            (71, "snow", "snow"),
            (95, "thunderstorm", "thunderstorm"),
            (96, "thunderstorm", "thunderstorm"),
        ] {
            let (_s, d, n, _p) = weather_code(code);
            assert_eq!((d, n), (day_icon, night_icon), "code {code}");
        }
    }
}
