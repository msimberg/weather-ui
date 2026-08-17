use std::env;
use std::fmt;
use std::path::PathBuf;

pub struct Config {
    pub api_key: String,
    pub host: String,
    pub port: u16,
    pub static_dir: PathBuf,
    pub nominatim_base: String,
    pub contact: Option<String>,
}

#[derive(Debug)]
pub enum ConfigError {
    MissingApiKey,
    InvalidPort(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::MissingApiKey => {
                write!(f, "PIRATE_WEATHER_API_KEY is not set or empty; see README")
            }
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
            .filter(|k| !k.trim().is_empty())
            .ok_or(ConfigError::MissingApiKey)?;
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
    fn missing_key_error_is_actionable() {
        assert!(ConfigError::MissingApiKey
            .to_string()
            .contains("PIRATE_WEATHER_API_KEY"));
    }
}
