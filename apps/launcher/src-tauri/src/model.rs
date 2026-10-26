//! Domain model on the Rust side. Serialized as camelCase so the IPC payload
//! matches `src/platform/types.ts` exactly — the two must be kept in sync.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MB: u64 = 1024 * 1024;
pub const GB: u64 = 1024 * MB;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameApp {
    pub app_id: String,
    pub title: String,
    pub latin_title: String,
    pub subtitle: String,
    pub genres: Vec<String>,
    pub glyph: String,
    pub cover: String,
    pub score: f64,
    pub players: u64,
    pub latest_version: String,
    pub full_size_bytes: u64,
    pub delta_bytes: Option<u64>,
    pub installed_version: Option<String>,
    /// True when there is no real build behind the entry (client-side
    /// state-machine demo). Authored in the catalog seed, not computed.
    #[serde(default)]
    pub demo: Option<bool>,
}

/// `GET /v1/catalog` payload (the catalog server is authoritative).
#[derive(Clone, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDto {
    pub schema: u8,
    #[serde(default)]
    #[allow(dead_code)] // kept for contract completeness / future freshness checks
    pub generated_at: Option<String>,
    #[serde(default)]
    pub games: Vec<GameApp>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub app_id: String,
    pub version: String,
    pub size_bytes: u64,
    pub playtime_sec: u64,
    pub last_played_at: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Queued,
    Manifest,
    Downloading,
    Materialize,
    Verify,
    Ready,
    Paused,
    Failed,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    Install,
    Update,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub region: String,
    pub latency_ms: u64,
    pub speed_bps: u64,
    pub client_version: String,
    pub controller: bool,
}

/// What `bootstrap` returns; individual event patches reuse the same fields.
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub games: Vec<GameApp>,
    pub library: BTreeMap<String, LibraryEntry>,
    pub downloads: Vec<TaskDto>,
    pub conn: ConnectionInfo,
}

/// The shape the UI reads for a download. `kind` is public because both the
/// aside and the downloads page branch on install-vs-update copy.
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub app_id: String,
    pub title: String,
    pub kind: TaskKind,
    pub from_version: String,
    pub to_version: String,
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub chunk_total: u64,
    pub chunk_done: u64,
    pub thread_count: u64,
    pub phase: Phase,
    pub speed_bps: u64,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ToastKind {
    Info,
    Success,
    Error,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToastDto {
    pub id: u64,
    pub kind: ToastKind,
    pub title: String,
    pub detail: Option<String>,
}

/// `launcher://event` payload; the tag must be exactly `type` per the contract.
#[derive(Clone, Serialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventPayload {
    Patch { patch: Patch },
    Toast { toast: ToastDto },
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub games: Vec<GameApp>,
    pub library: BTreeMap<String, LibraryEntry>,
    pub downloads: Vec<TaskDto>,
    pub conn: ConnectionInfo,
}

/// 12.3 GB / 812.5 MB / 87 B — the same human units the frontend uses.
pub fn fmt_bytes(n: u64) -> String {
    if n >= GB {
        format!("{:.1} GB", n as f64 / GB as f64)
    } else if n >= MB {
        format!("{:.1} MB", n as f64 / MB as f64)
    } else {
        format!("{} B", n)
    }
}
