mod cache;
mod config;
mod merge;
mod pirate;
mod routes;

use std::process::exit;
use std::sync::Arc;

use tracing_subscriber::EnvFilter;

use crate::cache::Cache;
use crate::config::Config;
use crate::pirate::PirateClient;
use crate::routes::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("weather_ui=info,tower_http=info")),
        )
        .init();

    let config = Config::from_env().unwrap_or_else(|e| {
        eprintln!("error: {e}");
        exit(2);
    });

    let client = PirateClient::new(
        config.api_key.clone(),
        config.nominatim_base.clone(),
        config.contact.clone(),
    );
    let state = AppState::new(client, Arc::new(Cache::new()));
    let app = routes::router(state, &config.static_dir);

    let addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| {
        tracing::error!(%addr, error = %e, "failed to bind");
        exit(2);
    });
    tracing::info!(%addr, "weather-ui listening");
    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
    {
        tracing::error!(error = %e, "server error");
        exit(1);
    }
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown requested");
}
