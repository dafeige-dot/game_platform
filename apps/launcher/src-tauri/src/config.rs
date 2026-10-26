//! Desktop client configuration. Config file lives at
//! `%LOCALAPPDATA%/Stellar/config.json`; a missing file means "dev defaults"
//! (the local reference server), which is the right posture for M1.

use std::path::PathBuf;

const DEV_CATALOG_BASE: &str = "http://127.0.0.1:8787";

fn config_path() -> PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("Stellar").join("config.json"))
        .unwrap_or_else(|_| PathBuf::from("Stellar").join("config.json"))
}

fn read_config() -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(config_path()).ok()?;
    serde_json::from_str(&text).ok()
}

fn str_field(name: &str, fallback: &str) -> String {
    read_config()
        .and_then(|v| v[name].as_str().map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// Origin of the catalog + object endpoints, no trailing slash.
pub fn catalog_base() -> String {
    str_field("catalogBase", DEV_CATALOG_BASE)
}

/// Where the self-check installs land.
pub fn install_root() -> PathBuf {
    let base = str_field(
        "installRoot",
        &std::env::var("LOCALAPPDATA")
            .map(|d| format!("{d}\\Stellar"))
            .unwrap_or_else(|_| "Stellar".into()),
    );
    PathBuf::from(base).join("dev-install")
}
