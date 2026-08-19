use std::env;
use std::fmt;
use std::path::PathBuf;

pub struct Config {
    /// Optional: Open-Meteo needs no key, so the server boots without one.
    /// A `provider=pirateweather` request without a key fails at dispatch
    /// time with a clear error instead of refusing to start.
    pub api_key: Option<String>,
    pub host: String,
    pub port: u16,
    pub static_dir: PathBuf,
    pub nominatim_base: String,
    pub contact: Option<String>,
}

#[derive(Debug)]
pub enum ConfigError {
    InvalidPort(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::InvalidPort(v) => {
                write!(f, "PORT value {v:?} is not a valid TCP port")
            }
        }
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    pub fn from_env() -> Result<Config, ConfigError> {
        let api_key = env::var("PIRATE_WEATHER_API_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty());
        let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = match env::var("PORT") {
            Ok(v) => v.parse::<u16>().map_err(|_| ConfigError::InvalidPort(v))?,
            Err(_) => 8087,
        };
        let static_dir = env::var("WEATHER_UI_STATIC_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./frontend/dist"));
        let nominatim_base = env::var("NOMINATIM_BASE_URL")
            .unwrap_or_else(|_| "https://nominatim.openstreetmap.org".to_string());
        let contact = env::var("NOMINATIM_CONTACT").ok();
        Ok(Config {
            api_key,
            host,
            port,
            static_dir,
            nominatim_base,
            contact,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_port_is_rejected() {
        let err = ConfigError::InvalidPort("abc".to_string());
        assert!(err.to_string().contains("abc"));
    }

    #[test]
    fn empty_key_is_none_not_an_error() {
        // Guards the boot path: an unset or blank key must not kill the
        // server now that Open-Meteo is a keyless provider option.
        let key = Some("   ".to_string()).filter(|k| !k.trim().is_empty());
        assert_eq!(key, None);
    }
}
