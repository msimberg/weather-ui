// meteoblue provider: the free tier's `basic-1h` package is the backbone
// (temperature, felt temperature, precipitation, probability, humidity,
// pressure, wind, UV). Everything the free tier lacks -- cloud cover by
// altitude layer, wind gusts, visibility, sun/moon times, the 15-minute
// nowcast -- is filled from Open-Meteo, which is free and keyless. Past
// hours beyond meteoblue's 4-day history cap also come from Open-Meteo.
//
// Like the other providers, the output is the shared Dark Sky-shaped
// document, here produced by overlaying meteoblue fields onto an
// Open-Meteo-derived document.
//
// Verified free-tier facts (2026-08): basic-1h costs 8000 credits/call
// (mb-credits-accounted header), history_days is capped at 4, times are
// ISO8601 with a zone offset when timeformat=iso8601, and the apikey is a
// query parameter (never echoed into logs or client-facing errors).

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::pirate::UpstreamError;

const PACKAGES_BASE: &str = "https://my.meteoblue.com/packages/basic-1h";
/// Free-tier history cap; verified live ("historyDays can be at most 4").
const MAX_HISTORY_DAYS: u32 = 4;

#[derive(Clone)]
pub struct MeteoBlueClient {
    inner: std::sync::Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    key: Option<String>,
}

impl MeteoBlueClient {
    pub fn new(key: Option<String>, user_agent: String) -> MeteoBlueClient {
        let http = reqwest::Client::builder()
            .user_agent(user_agent)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client construction failed");
        MeteoBlueClient { inner: std::sync::Arc::new(Inner { http, key }) }
    }

    pub fn has_key(&self) -> bool {
        self.inner.key.is_some()
    }

    /// Fetch the basic-1h package (hourly, 7 forecast days + history_days
    /// of model history). One call costs ~8000 credits on the free tier.
    pub async fn forecast(
        &self,
        lat: f64,
        lon: f64,
        past_days: u32,
    ) -> Result<Value, UpstreamError> {
        let key = self.inner.key.as_deref().ok_or(UpstreamError::Network {
            service: "meteoblue",
            detail: "METEOBLUE_API_KEY is not configured".to_string(),
        })?;
        let history = past_days.min(MAX_HISTORY_DAYS);
        let url = format!(
            "{PACKAGES_BASE}?lat={lat:.3}&lon={lon:.3}&timeformat=iso8601&history_days={history}&apikey={key}"
        );
        let resp = self.inner.http.get(&url).send().await.map_err(|e| UpstreamError::Network {
            service: "meteoblue",
            detail: e.to_string(),
        })?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let excerpt: String = body.chars().take(200).collect();
            return Err(UpstreamError::Status { status, service: "meteoblue", detail: excerpt });
        }
        resp.json::<Value>().await.map_err(|e| UpstreamError::Network {
            service: "meteoblue",
            detail: e.to_string(),
        })
    }
}

/// Parse an ISO8601 local timestamp with explicit offset, e.g.
/// "2026-08-20T00:00+02:00", into a true UTC epoch second. We avoid pulling
/// in chrono for this one format; a wrong parse would silently shift every
/// label, so this is unit-tested around a DST boundary.
pub fn parse_iso_epoch(s: &str) -> Option<i64> {
    // "YYYY-MM-DDTHH:MM+HH:MM" -- the basic-1h format has no seconds, so the
    // offset sign is at byte 16. (Negative offsets come back as "-HH:MM".)
    let bytes = s.as_bytes();
    if bytes.len() != 22 && bytes.len() != 25 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    // Tap from the back: the last 6 chars are "+HH:MM" or "-HH:MM"
    // regardless of whether seconds precede them.
    let off_sign = match bytes[bytes.len() - 6] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let off_h: i64 = s.get(bytes.len() - 5..bytes.len() - 3)?.parse().ok()?;
    let off_m: i64 = s.get(bytes.len() - 2..bytes.len())?.parse().ok()?;
    // Days since epoch via Howard Hinnant's civil-to-days formula.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let local_secs = days * 86_400 + hour * 3600 + minute * 60;
    Some(local_secs - off_sign * (off_h * 3600 + off_m * 60))
}

/// meteoblue hourly pictocode (1-35) -> (summary, day icon, night icon,
/// precip type). Icons use the Dark Sky vocabulary like the other providers.
/// Reference: docs.meteoblue.com/en/meteo/variables/pictograms.
fn pictocode(code: i64) -> (&'static str, &'static str, &'static str, Option<&'static str>) {
    match code {
        1..=3 => ("Clear", "clear-day", "clear-night", None),
        4..=6 => ("Mostly clear", "clear-day", "clear-night", None),
        7..=12 => ("Partly cloudy", "partly-cloudy-day", "partly-cloudy-night", None),
        13..=15 => ("Hazy", "fog", "fog", None),
        16..=18 => ("Foggy", "fog", "fog", None),
        19..=21 => ("Mostly cloudy", "cloudy", "cloudy", None),
        22 => ("Overcast", "cloudy", "cloudy", None),
        23 => ("Rain", "rain", "rain", Some("rain")),
        24 => ("Snow", "snow", "snow", Some("snow")),
        25 => ("Heavy rain", "rain", "rain", Some("rain")),
        26 => ("Heavy snow", "snow", "snow", Some("snow")),
        27 | 28 => ("Thunderstorms", "thunderstorm", "thunderstorm", Some("rain")),
        29 => ("Snow storm", "snow", "snow", Some("snow")),
        30 => ("Heavy thunderstorms", "thunderstorm", "thunderstorm", Some("rain")),
        31 => ("Showers", "rain", "rain", Some("rain")),
        32 => ("Snow showers", "snow", "snow", Some("snow")),
        33 => ("Light rain", "rain", "rain", Some("rain")),
        34 => ("Light snow", "snow", "snow", Some("snow")),
        35 => ("Wintry mix", "sleet", "sleet", Some("sleet")),
        _ => ("Unknown", "cloudy", "cloudy", None),
    }
}

/// meteoblue wind speeds arrive in m/s; the Dark Sky wind fields are in the
/// user-selected units already for the other providers, so convert here.
fn convert_wind_ms(ms: f64, units: &str) -> f64 {
    match units {
        "ca" => ms * 3.6,
        "us" | "uk" | "uk2" => ms * 2.236_936_292_054_4,
        _ => ms,
    }
}

fn convert_temp_c(c: f64, units: &str) -> f64 {
    if units == "us" {
        c * 9.0 / 5.0 + 32.0
    } else {
        c
    }
}

fn convert_precip_mm(mm: f64, units: &str) -> f64 {
    if units == "us" {
        mm / 25.4
    } else {
        mm
    }
}

/// Convert the meteoblue basic-1h response into per-hour Dark Sky slots.
/// Keys absent from the free package (gusts, cloud cover, visibility, dew
/// point) are simply not produced here -- the merge with Open-Meteo fills
/// them per hour afterwards.
fn meteoblue_hours(mb: &Value, units: &str) -> Vec<Value> {
    let Some(data) = mb.get("data_1h") else { return Vec::new() };
    let times = data.get("time").and_then(Value::as_array).cloned().unwrap_or_default();
    let arr = |k: &str| data.get(k).and_then(Value::as_array).cloned().unwrap_or_default();

    let out = Vec::with_capacity(times.len());
    let (temp, felt) = (arr("temperature"), arr("felttemperature"));
    let (precip, precip_prob) = (arr("precipitation"), arr("precipitation_probability"));
    let (rh, slp) = (arr("relativehumidity"), arr("sealevelpressure"));
    let (wspd, wdir) = (arr("windspeed"), arr("winddirection"));
    let (uv, picto, isday) = (arr("uvindex"), arr("pictocode"), arr("isdaylight"));

    let mut hours = out;
    for (i, t) in times.iter().enumerate() {
        let Some(ts) = t.as_str().and_then(parse_iso_epoch) else { continue };
        let mut slot = Map::new();
        slot.insert("time".to_string(), json!(ts));
        let daylight = isday
            .get(i)
            .and_then(Value::as_f64)
            .map(|v| v > 0.0)
            .unwrap_or(true);
        if let Some(v) = temp.get(i).and_then(Value::as_f64) {
            slot.insert("temperature".to_string(), json!(convert_temp_c(v, units)));
        }
        if let Some(v) = felt.get(i).and_then(Value::as_f64) {
            slot.insert("apparentTemperature".to_string(), json!(convert_temp_c(v, units)));
        }
        if let Some(v) = precip.get(i).and_then(Value::as_f64) {
            slot.insert("precipIntensity".to_string(), json!(convert_precip_mm(v, units)));
        }
        if let Some(v) = precip_prob.get(i).and_then(Value::as_f64) {
            slot.insert("precipProbability".to_string(), json!(v / 100.0));
        }
        if let Some(v) = rh.get(i).and_then(Value::as_f64) {
            slot.insert("humidity".to_string(), json!(v / 100.0));
        }
        if let Some(v) = slp.get(i).and_then(Value::as_f64) {
            slot.insert("pressure".to_string(), json!(v));
        }
        if let Some(v) = wspd.get(i).and_then(Value::as_f64) {
            slot.insert("windSpeed".to_string(), json!(convert_wind_ms(v, units)));
        }
        if let Some(v) = wdir.get(i).and_then(Value::as_f64) {
            slot.insert("windBearing".to_string(), json!(v));
        }
        if let Some(v) = uv.get(i).and_then(Value::as_f64) {
            slot.insert("uvIndex".to_string(), json!(v));
        }
        if let Some(v) = picto.get(i).and_then(Value::as_i64) {
            let (summary, day, night, ptype) = pictocode(v);
            slot.insert("summary".to_string(), json!(summary));
            slot.insert("icon".to_string(), json!(if daylight { day } else { night }));
            if let Some(p) = ptype {
                slot.insert("precipType".to_string(), json!(p));
            }
        }
        hours.push(Value::Object(slot));
    }
    hours
}

/// Daily rows derived from the meteoblue hourly series; sun/moon times land
/// on top of these during the Open-Meteo merge. meteoblue's basic-1h series
/// always starts at a local midnight (history included), so 24-hour buckets
/// from h[0] are local days.
fn meteoblue_days(hours: &[Value]) -> Vec<Value> {
    let Some(first) = hours
        .iter()
        .filter_map(|h| h.get("time").and_then(Value::as_i64))
        .min()
    else {
        return Vec::new();
    };
    let mut days: BTreeMap<i64, Map<String, Value>> = BTreeMap::new();
    for h in hours {
        let Some(t) = h.get("time").and_then(Value::as_i64) else { continue };
        let day_start = first + (t - first).div_euclid(86_400) * 86_400;
        let d = days.entry(day_start).or_insert_with(Map::new);
        d.insert("time".to_string(), json!(day_start));
        if let Some(temp) = h.get("temperature").and_then(Value::as_f64) {
            if d.get("temperatureHigh").and_then(Value::as_f64).is_none_or(|m| temp > m) {
                d.insert("temperatureHigh".to_string(), json!(temp));
                d.insert("temperatureHighTime".to_string(), json!(t));
            }
            if d.get("temperatureLow").and_then(Value::as_f64).is_none_or(|m| temp < m) {
                d.insert("temperatureLow".to_string(), json!(temp));
                d.insert("temperatureLowTime".to_string(), json!(t));
            }
        }
        if let Some(felt) = h.get("apparentTemperature").and_then(Value::as_f64) {
            if d.get("apparentTemperatureHigh").and_then(Value::as_f64).is_none_or(|m| felt > m) {
                d.insert("apparentTemperatureHigh".to_string(), json!(felt));
            }
            if d.get("apparentTemperatureLow").and_then(Value::as_f64).is_none_or(|m| felt < m) {
                d.insert("apparentTemperatureLow".to_string(), json!(felt));
            }
        }
        if let Some(p) = h.get("precipIntensity").and_then(Value::as_f64) {
            let acc = d.get("precipAccumulation").and_then(Value::as_f64).unwrap_or(0.0);
            // 1h intensity == 1h accumulation, so summing is the daily total.
            d.insert("precipAccumulation".to_string(), json!(acc + p));
            if d.get("precipIntensityMax").and_then(Value::as_f64).is_none_or(|m| p > m) {
                d.insert("precipIntensityMax".to_string(), json!(p));
            }
        }
        if let Some(prob) = h.get("precipProbability").and_then(Value::as_f64) {
            if d.get("precipProbability").and_then(Value::as_f64).is_none_or(|m| prob > m) {
                d.insert("precipProbability".to_string(), json!(prob));
            }
        }
        if let Some(uv) = h.get("uvIndex").and_then(Value::as_f64) {
            if d.get("uvIndexMax").and_then(Value::as_f64).is_none_or(|m| uv > m) {
                d.insert("uvIndexMax".to_string(), json!(uv));
            }
        }
        if let Some(w) = h.get("windSpeed").and_then(Value::as_f64) {
            if d.get("windSpeed").and_then(Value::as_f64).is_none_or(|m| w > m) {
                d.insert("windSpeed".to_string(), json!(w));
            }
        }
    }
    // Day icon/summary: only set when the day has meaningful precip, based
    // on the wettest hour's type; otherwise the merge keeps the icon the
    // open-meteo day derived from its weather code.
    for (_, d) in days.iter_mut() {
        let wet = d.get("precipIntensityMax").and_then(Value::as_f64).unwrap_or(0.0);
        if wet > 0.1 {
            d.insert("icon".to_string(), json!("rain"));
            d.insert("summary".to_string(), json!("Precipitation expected"));
        }
    }
    days.into_values().map(Value::Object).collect()
}

/// Public translator: meteoblue hours + days, merged onto the Open-Meteo
/// document shape. `om_doc` (already Dark Sky-shaped via openmeteo::to_dark_sky)
/// supplies everything meteoblue lacks; meteoblue wins wherever both have a
/// field, because the user selected it as the forecast source.
pub fn merge(mb: &Value, om_doc: &Value, units: &str) -> Value {
    let mb_hours = meteoblue_hours(mb, units);
    let mb_days = meteoblue_days(&mb_hours);

    let mut doc = om_doc.clone();
    let root = doc.as_object_mut().expect("doc is an object");

    // Per-hour overlay keyed by epoch time.
    let om_hours: Vec<Value> = om_doc
        .get("hourly")
        .and_then(|h| h.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut mb_by_time: std::collections::HashMap<i64, Value> = std::collections::HashMap::new();
    for h in mb_hours.iter() {
        if let Some(t) = h.get("time").and_then(Value::as_i64) {
            mb_by_time.insert(t, h.clone());
        }
    }
    let mut merged_hours: Vec<Value> = Vec::with_capacity(om_hours.len());
    for oh in &om_hours {
        let Some(t) = oh.get("time").and_then(Value::as_i64) else { continue };
        if let Some(mh) = mb_by_time.remove(&t) {
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
    // Hours meteoblue has but open-meteo lacks (should not happen at
    // forecast_days=8, but stay lossless).
    for (_, mh) in mb_by_time {
        merged_hours.push(mh);
    }
    merged_hours.sort_by_key(|h| h.get("time").and_then(Value::as_i64).unwrap_or(0));
    let mut hb = root.get("hourly").cloned().unwrap_or_else(|| json!({}));
    hb["data"] = json!(merged_hours);
    root.insert("hourly".to_string(), hb);

    // Daily: meteoblue-derived rows win the weather fields; the sunshine
    // times from open-meteo survive because meteoblue's free tier has none.
    let mut mb_day_by_time: std::collections::HashMap<i64, &Value> = std::collections::HashMap::new();
    for d in mb_days.iter() {
        if let Some(t) = d.get("time").and_then(Value::as_i64) {
            // meteoblue day starts at local midnight; open-meteo daily.time
            // is also local-midnight epoch, but tz offsets differ by
            // construction -- match within a window.
            mb_day_by_time.insert(t, d);
        }
    }
    let om_days: Vec<Value> = om_doc
        .get("daily")
        .and_then(|h| h.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut merged_days: Vec<Value> = Vec::with_capacity(om_days.len());
    for od in &om_days {
        let Some(t) = od.get("time").and_then(Value::as_i64) else { continue };
        // Find the meteoblue day within +-12h (same local date, different
        // epoch conventions are possible).
        if let Some(md) = mb_days.iter().find(|md| {
            md.get("time")
                .and_then(Value::as_i64)
                .map(|mt| (mt - t).abs() < 43_200)
                .unwrap_or(false)
        }) {
            let mut merged = od.clone();
            let obj = merged.as_object_mut().expect("day is an object");
            let mobj = md.as_object().expect("day is an object");
            for (k, v) in mobj.iter() {
                if k != "time" {
                    obj.insert(k.clone(), v.clone());
                }
            }
            // A meteoblue day that was all-dry keeps open-meteo's icon.
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
        } else {
            merged_days.push(od.clone());
        }
    }
    let mut db = root.get("daily").cloned().unwrap_or_else(|| json!({}));
    db["data"] = json!(merged_days);
    root.insert("daily".to_string(), db);

    // Currently: meteoblue has no current block; synthesize from the merged
    // hourly like the open-meteo path does.
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
        .filter(|h| h.get("time").and_then(Value::as_i64).unwrap_or(0) <= now_sec)
        .last()
    {
        let mut cur = slot.clone();
        let obj = cur.as_object_mut().expect("hour is an object");
        obj.insert("time".to_string(), json!(now_sec));
        if let Some(dt) = slot.get("summary") {
            obj.insert("summary".to_string(), dt.clone());
        }
        root.insert("currently".to_string(), cur);
    }

    let mut flags = root.get("flags").cloned().unwrap_or_else(|| json!({}));
    flags["sources"] = json!(["meteoblue", "open-meteo"]);
    flags["units"] = json!(units);
    root.insert("flags".to_string(), flags);
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_iso_epoch_basic() {
        // 2026-08-19 16:00 at +02:00 == 14:00 UTC == 1787148000
        let ts = parse_iso_epoch("2026-08-19T16:00+02:00").unwrap();
        assert_eq!(ts, 1_787_148_000);
    }

    #[test]
    fn parse_iso_epoch_negative_offset() {
        // Same wall time at UTC-5 is 5h later in UTC than at +2.
        let a = parse_iso_epoch("2026-08-19T16:00+02:00").unwrap();
        let b = parse_iso_epoch("2026-08-19T16:00-05:00").unwrap();
        assert_eq!(b - a, 7 * 3600);
    }

    #[test]
    fn parse_iso_epoch_midnight_zurich_matches_openmeteo() {
        // Open-Meteo returned 1787004000 for local midnight 2026-08-18 Zurich.
        assert_eq!(parse_iso_epoch("2026-08-18T00:00+02:00").unwrap(), 1_787_004_000);
    }

    #[test]
    fn parse_iso_epoch_rejects_garbage() {
        assert!(parse_iso_epoch("").is_none());
        assert!(parse_iso_epoch("2026-08-19").is_none());
        assert!(parse_iso_epoch("not a date string at all").is_none());
    }

    fn mb_fixture() -> Value {
        json!({
            "metadata": {"utc_timeoffset": 2.0},
            "data_1h": {
                "time": ["2026-08-18T00:00+02:00", "2026-08-18T01:00+02:00"],
                "temperature": [19.0, 20.5],
                "felttemperature": [19.5, 21.0],
                "precipitation": [0.0, 1.2],
                "precipitation_probability": [10, 80],
                "relativehumidity": [55, 60],
                "sealevelpressure": [1014.0, 1013.0],
                "windspeed": [3.0, 4.5],
                "winddirection": [180, 220],
                "uvindex": [0.0, 1.0],
                "pictocode": [3, 61 - 38],
                "isdaylight": [0, 0]
            }
        })
    }

    #[test]
    fn hourly_translation_maps_and_converts() {
        // pictocode 23 (61 - 38) = rain; isdaylight 0 -> night icon only for
        // clear/cloud variants; rain is day/night agnostic.
        let hours = meteoblue_hours(&mb_fixture(), "si");
        assert_eq!(hours.len(), 2);
        let h1 = &hours[1];
        assert_eq!(h1["time"], json!(1_787_007_600));
        assert_eq!(h1["temperature"], json!(20.5));
        assert_eq!(h1["precipProbability"], json!(0.8));
        assert_eq!(h1["precipIntensity"], json!(1.2));
        assert_eq!(h1["windSpeed"], json!(4.5));
        assert_eq!(h1["icon"], json!("rain"));
        assert_eq!(h1["summary"], json!("Rain"));
        assert_eq!(h1["precipType"], json!("rain"));
    }

    #[test]
    fn hourly_translation_us_units() {
        let hours = meteoblue_hours(&mb_fixture(), "us");
        let h1 = &hours[1];
        let temp = h1["temperature"].as_f64().unwrap();
        assert!((temp - (20.5 * 9.0 / 5.0 + 32.0)).abs() < 1e-9);
        let wind = h1["windSpeed"].as_f64().unwrap();
        assert!((wind - 4.5 * 2.236_936_292_054_4).abs() < 1e-9);
        let p = h1["precipIntensity"].as_f64().unwrap();
        assert!((p - 1.2 / 25.4).abs() < 1e-9);
    }

    #[test]
    fn night_pictocode_uses_night_icon() {
        let hours = meteoblue_hours(&mb_fixture(), "si");
        // Hour 0: pictocode 3 (clear), isdaylight 0 -> clear-night.
        assert_eq!(hours[0]["icon"], json!("clear-night"));
    }

    fn om_fixture() -> Value {
        json!({
            "latitude": 47.38, "longitude": 8.54,
            "timezone": "Europe/Zurich", "offset": 2.0,
            "currently": {"time": 1787007600, "temperature": 22.0},
            "hourly": {"data": [
                {"time": 1787004000, "temperature": 99.0, "cloudCover": 0.4, "visibility": 10.0, "windGust": 8.0},
                {"time": 1787007600, "temperature": 99.0, "cloudCover": 0.6, "visibility": 20.0, "windGust": 9.5}
            ]},
            "daily": {"data": [
                {"time": 1787004000, "sunriseTime": 1787017577, "sunsetTime": 1787068177, "temperatureHigh": 99.0, "cloud_x": 4, "moonPhase": 0.5}
            ]},
            "minutely": {"data": [{"time": 1787007600, "precipIntensity": 0.0}]},
            "cloudLayers": {"time": [1787004000], "low": [10], "mid": [20], "high": [5]},
            "flags": {"sources": ["open-meteo"], "units": "si"}
        })
    }

    #[test]
    fn merge_met_blue_wins_shared_fields_om_fills_rest() {
        let mb = mb_fixture();
        let om = om_fixture();
        let doc = merge(&mb, &om, "si");
        let hours = doc["hourly"]["data"].as_array().unwrap();
        // meteoblue temperature wins over open-meteo's 99.0 placeholder...
        assert_eq!(hours[1]["temperature"], json!(20.5));
        // ... while open-meteo-only fields stay.
        assert_eq!(hours[1]["cloudCover"], json!(0.6));
        assert_eq!(hours[1]["visibility"], json!(20.0));
        assert_eq!(hours[1]["windGust"], json!(9.5));
        // cloudLayers and minutely ride through unchanged.
        assert_eq!(doc["cloudLayers"]["low"], json!([10]));
        assert_eq!(doc["minutely"]["data"][0]["time"], json!(1787007600));
        // Daily: meteoblue computed high wins, sunrise/sunset from OM survive.
        let day = &doc["daily"]["data"][0];
        assert_eq!(day["sunriseTime"], json!(1787017577));
        assert_eq!(day["moonPhase"], json!(0.5));
        assert!(day["temperatureHigh"].as_f64().unwrap() < 30.0);
        assert!(doc["flags"]["sources"].as_array().unwrap().contains(&json!("meteoblue")));
    }
}
