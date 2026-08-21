use std::collections::BTreeMap;

use serde_json::{json, Value};

const SECS_PER_DAY: i64 = 86_400;

/// Map a unix timestamp to a location-local day index. Pirate Weather returns
/// `offset` in hours at the requested location; using the current offset for
/// past days can misplace the boundary by an hour across DST changes, which
/// only matters if a filter ever compared exact day edges. We use day keys
/// solely to dedupe full-day entries, where a one-hour shift never changes
/// which key an entry collides with.
pub fn day_key(time_unix: i64, offset_hours: f64) -> i64 {
    (time_unix + (offset_hours * 3600.0).round() as i64).div_euclid(SECS_PER_DAY)
}

fn point_time(point: &Value) -> Option<i64> {
    point
        .get("time")
        .and_then(|t| t.as_i64().or_else(|| t.as_f64().map(|f| f as i64)))
}

fn block_data<'a>(response: &'a Value, block: &str) -> &'a [Value] {
    response
        .get(block)
        .and_then(|b| b.get("data"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Combine a forecast response with per-past-day timemachine responses into a
/// single Dark Sky-shaped document. Past days are inserted first so the
/// fresher forecast model wins wherever the two overlap (the current day).
pub fn merge(forecast: &Value, past: &[Value], warnings: Vec<String>) -> Value {
    let offset = forecast
        .get("offset")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let mut hourly: BTreeMap<i64, Value> = BTreeMap::new();
    for day in past {
        for point in block_data(day, "hourly") {
            if let Some(t) = point_time(point) {
                hourly.insert(t, point.clone());
            }
        }
    }
    for point in block_data(forecast, "hourly") {
        if let Some(t) = point_time(point) {
            hourly.insert(t, point.clone());
        }
    }

    let mut daily: BTreeMap<i64, (i64, Value)> = BTreeMap::new();
    for day in past {
        for point in block_data(day, "daily") {
            if let Some(t) = point_time(point) {
                daily.insert(day_key(t, offset), (t, point.clone()));
            }
        }
    }
    for point in block_data(forecast, "daily") {
        if let Some(t) = point_time(point) {
            daily.insert(day_key(t, offset), (t, point.clone()));
        }
    }

    let mut out = forecast.clone();
    let root = out.as_object_mut().expect("forecast response is an object");
    let hourly_points: Vec<Value> = hourly.into_values().collect();
    let daily_points: Vec<Value> = daily.into_values().map(|(_, v)| v).collect();
    let mut hourly_block = root.get("hourly").cloned().unwrap_or_else(|| json!({}));
    hourly_block["data"] = json!(hourly_points);
    let mut daily_block = root.get("daily").cloned().unwrap_or_else(|| json!({}));
    daily_block["data"] = json!(daily_points);
    root.insert("hourly".to_string(), hourly_block);
    root.insert("daily".to_string(), daily_block);
    root.insert(
        "meta".to_string(),
        json!({
            "mergedPastDays": past.len(),
            "warnings": warnings,
        }),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hour_point(t: i64, temp: f64) -> Value {
        json!({"time": t, "temperature": temp})
    }

    fn day_point(t: i64, high: f64) -> Value {
        json!({"time": t, "temperatureHigh": high})
    }

    #[test]
    fn forecast_wins_overlapping_hour() {
        // Same hour 1000 in both sources: forecast value must replace the archive one.
        let forecast = json!({
            "offset": 1.0,
            "hourly": {"data": [hour_point(1000, 20.0), hour_point(4600, 21.0)]},
            "daily": {"data": [day_point(3600, 25.0)]}
        });
        let past = json!({
            "hourly": {"data": [hour_point(1000, 18.0), hour_point(-2600, 10.0)]},
            "daily": {"data": [day_point(14_400, 19.0)]}
        });
        let merged = merge(&forecast, &[past], vec![]);
        let hours = merged["hourly"]["data"].as_array().unwrap();
        assert_eq!(hours.len(), 3);
        assert_eq!(hours[0], hour_point(-2600, 10.0));
        assert_eq!(hours[1], hour_point(1000, 20.0));
        assert_eq!(hours[2], hour_point(4600, 21.0));
        let days = merged["daily"]["data"].as_array().unwrap();
        assert_eq!(days.len(), 1);
        assert_eq!(days[0], day_point(3600, 25.0));
        assert_eq!(merged["meta"]["mergedPastDays"], json!(1));
    }

    #[test]
    fn timemachine_noon_and_forecast_midnight_share_a_day() {
        // Timemachine daily.time is the requested (noon-local) timestamp while
        // forecast daily.time is local midnight; both must dedupe to one day.
        // At UTC-5: local midnight = 05:00 UTC, local noon = 17:00 UTC of the
        // same local date (day 0 here is 1970-01-01 local for both).
        let offset = -5.0;
        let midnight_local_utc = 18_000;
        let noon_local_utc = 18_000 + 43_200;
        let forecast = json!({
            "offset": offset,
            "daily": {"data": [day_point(midnight_local_utc, 30.0)]}
        });
        let past = json!({
            "daily": {"data": [day_point(noon_local_utc, 22.0)]}
        });
        assert_eq!(
            day_key(midnight_local_utc, offset),
            day_key(noon_local_utc, offset)
        );
        let merged = merge(&forecast, &[past], vec![]);
        let days = merged["daily"]["data"].as_array().unwrap();
        assert_eq!(days.len(), 1);
        assert_eq!(days[0]["temperatureHigh"], json!(30.0));
    }

    #[test]
    fn warnings_pass_through() {
        let forecast = json!({"offset": 0.0});
        let merged = merge(&forecast, &[], vec!["past day -3 unavailable".to_string()]);
        assert_eq!(
            merged["meta"]["warnings"],
            json!(["past day -3 unavailable"])
        );
    }
}
