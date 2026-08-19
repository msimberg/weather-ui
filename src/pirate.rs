use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;
use serde_json::Value;

const FORECAST_BASE: &str = "https://api.pirateweather.net/forecast";
const TIMEMACHINE_BASE: &str = "https://timemachine.pirateweather.net/forecast";

/// Upstream error details stay server-side: request URLs carry the API key,
/// so error text is never forwarded to clients.
#[derive(Debug)]
pub enum UpstreamError {
    Network { service: &'static str, detail: String },
    Status { status: StatusCode, service: &'static str, detail: String },
}

impl UpstreamError {
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            UpstreamError::Network { .. } => None,
            UpstreamError::Status { status, .. } => Some(*status),
        }
    }
}

impl fmt::Display for UpstreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UpstreamError::Network { service, detail } => {
                write!(f, "{service}: {detail}")
            }
            UpstreamError::Status { status, service, detail } => {
                write!(f, "{service} returned {status}: {detail}")
            }
        }
    }
}

impl std::error::Error for UpstreamError {}

#[derive(Clone)]
pub struct PirateClient {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    key: Option<String>,
    nominatim_base: String,
}

impl PirateClient {
    pub fn new(
        key: Option<String>,
        nominatim_base: String,
        contact: Option<String>,
    ) -> PirateClient {
        let http = reqwest::Client::builder()
            .user_agent(Self::user_agent(contact.as_deref()))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client construction failed");
        PirateClient {
            inner: Arc::new(Inner { http, key, nominatim_base }),
        }
    }

    /// User agent shared with the keyless Open-Meteo client.
    pub fn user_agent(contact: Option<&str>) -> String {
        match contact {
            Some(c) if !c.trim().is_empty() => {
                format!("weather-ui/{} ({c})", env!("CARGO_PKG_VERSION"))
            }
            _ => format!("weather-ui/{}", env!("CARGO_PKG_VERSION")),
        }
    }

    pub fn has_key(&self) -> bool {
        self.inner.key.is_some()
    }

    fn key(&self) -> Result<&str, UpstreamError> {
        self.inner.key.as_deref().ok_or(UpstreamError::Network {
            service: "pirate weather",
            detail: "PIRATE_WEATHER_API_KEY is not configured".to_string(),
        })
    }

    fn redact(&self, text: String) -> String {
        match self.inner.key.as_deref() {
            Some(k) if !k.is_empty() => text.replace(k, "***"),
            _ => text,
        }
    }

    async fn get_json(&self, service: &'static str, url: &str) -> Result<Value, UpstreamError> {
        let resp = self.inner.http.get(url).send().await.map_err(|e| UpstreamError::Network {
            service,
            detail: self.redact(e.to_string()),
        })?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let excerpt: String = self.redact(body.chars().take(200).collect());
            return Err(UpstreamError::Status { status, service, detail: excerpt });
        }
        resp.error_for_status_ref().map_err(|e| UpstreamError::Network {
            service,
            detail: self.redact(e.to_string()),
        })?;
        resp.json::<Value>().await.map_err(|e| UpstreamError::Network {
            service,
            detail: self.redact(e.to_string()),
        })
    }

    fn coords(lat: f64, lon: f64) -> String {
        // Pirate Weather resolves to a 13 km model cell; 3 decimals never changes the result.
        format!("{lat:.3},{lon:.3}")
    }

    pub async fn forecast(
        &self,
        lat: f64,
        lon: f64,
        units: &str,
        lang: &str,
        exclude: &str,
        aimodels: bool,
    ) -> Result<Value, UpstreamError> {
        let mut url = format!(
            "{}/{}/{}?version=2&extend=hourly&icon=pirate&units={}&lang={}",
            FORECAST_BASE,
            self.key()?,
            Self::coords(lat, lon),
            units,
            lang
        );
        if !exclude.is_empty() {
            url.push_str("&exclude=");
            url.push_str(exclude);
        }
        if aimodels {
            url.push_str("&include=aimodels");
        }
        self.get_json("pirate weather forecast", &url).await
    }

    /// Cloud cover by altitude layer from Open-Meteo (free, no key). Kept out
    /// of the merge hot path: failures degrade to a missing block plus a
    /// warning instead of failing the whole weather response.
    pub async fn cloud_layers(
        &self,
        lat: f64,
        lon: f64,
        past_days: u32,
    ) -> Result<Value, UpstreamError> {
        let url = format!(
            "https://api.open-meteo.com/v1/forecast?latitude={lat:.3}&longitude={lon:.3}\
             &hourly=cloudcover_low,cloudcover_mid,cloudcover_high\
             &timeformat=unixtime&timezone=UTC&past_days={past_days}&forecast_days=8"
        );
        self.get_json("open-meteo", &url).await
    }

    pub async fn timemachine(
        &self,
        lat: f64,
        lon: f64,
        unix_secs: i64,
        units: &str,
        lang: &str,
    ) -> Result<Value, UpstreamError> {
        let url = format!(
            "{}/{}/{},{}?version=2&units={}&lang={}",
            TIMEMACHINE_BASE,
            self.key()?,
            Self::coords(lat, lon),
            unix_secs,
            units,
            lang
        );
        self.get_json("pirate weather timemachine", &url).await
    }

    pub async fn geocode(&self, q: &str, lang: &str) -> Result<Value, UpstreamError> {
        let base = &self.inner.nominatim_base;
        let url = format!(
            "{base}/search?format=jsonv2&limit=6&accept-language={}&q={}",
            url_component(lang),
            url_component(q)
        );
        self.get_json("nominatim geocoding", &url).await
    }

    pub async fn reverse(&self, lat: f64, lon: f64, lang: &str) -> Result<Value, UpstreamError> {
        let base = &self.inner.nominatim_base;
        let url = format!(
            "{base}/reverse?format=jsonv2&zoom=14&accept-language={}&lat={lat:.5}&lon={lon:.5}",
            url_component(lang)
        );
        self.get_json("nominatim reverse", &url).await
    }
}

/// Minimal percent-encoding sufficient for query values (no reserved chars kept).
fn url_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display_never_contains_key() {
        let client = PirateClient::new(Some("secret-api-key".to_string()), String::new(), None);
        let raw = "request failed for https://api.pirateweather.net/forecast/secret-api-key/1,2"
            .to_string();
        let err = UpstreamError::Network { service: "svc", detail: client.redact(raw) };
        assert!(!err.to_string().contains("secret-api-key"));
    }

    #[test]
    fn keyless_client_redacts_nothing() {
        // No key configured: redact must be a no-op, not a panic.
        let client = PirateClient::new(None, String::new(), None);
        let raw = "plain error".to_string();
        assert_eq!(client.redact(raw), "plain error");
        assert!(!client.has_key());
    }

    #[test]
    fn url_component_encodes_reserved_chars() {
        assert_eq!(url_component("Ottawa, Canada"), "Ottawa%2C%20Canada");
        assert_eq!(url_component("Zurich"), "Zurich");
    }

    #[test]
    fn coords_are_fixed_precision() {
        assert_eq!(PirateClient::coords(47.3769, 8.5417), "47.377,8.542");
        assert_eq!(PirateClient::coords(-0.0, -122.4194), "-0.000,-122.419");
    }
}
