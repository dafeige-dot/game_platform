use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::engine::Engine;
use crate::model::Snapshot;

#[tauri::command]
pub fn bootstrap(engine: State<'_, Arc<Engine>>) -> Snapshot {
    engine.snapshot()
}

#[tauri::command]
pub fn download_action(
    engine: State<'_, Arc<Engine>>,
    app_id: String,
    action: String,
) -> Result<(), String> {
    engine.action(&app_id, &action)
}

#[tauri::command]
pub fn launch_app(engine: State<'_, Arc<Engine>>, app_id: String) {
    engine.launch(&app_id);
}

/// Which protocol core is linked in, plus its chunking constants. The UI
/// (设置页) uses this to prove the real engine is wired, not the mock.
#[tauri::command]
pub fn core_info() -> serde_json::Value {
    serde_json::json!({
        "crate": "cas-core-rs",
        "version": env!("CARGO_PKG_VERSION"),
        "chunk": {
            "gearSeed": cas_core_rs::chunker::GEAR_SEED,
            "min": cas_core_rs::chunker::MIN_SIZE,
            "normal": cas_core_rs::chunker::NORMAL_SIZE,
            "max": cas_core_rs::chunker::MAX_SIZE
        }
    })
}

/// Refresh the catalog from the configured origin. Local-first: the shell
/// already painted seed data; this call is authoritative and runs async, so a
/// dead catalog server must degrade to the seed, never block startup.
#[tauri::command]
pub fn refresh_catalog(engine: State<'_, Arc<Engine>>) {
    use cas_core_rs::client_runtime::{Fetcher, HttpFetcher};

    let engine = Arc::clone(&engine);
    let base = crate::config::catalog_base();
    std::thread::spawn(move || {
        let fetcher = HttpFetcher::new(&base);
        let fetched = Fetcher::fetch(&fetcher, "/v1/catalog");
        let bytes: Vec<u8> = match fetched {
            Ok(b) => b,
            Err(e) => {
                engine.push_toast(
                    crate::model::ToastKind::Info,
                    "目录源不可达，使用本地种子",
                    Some(format!("{base}: {e}")),
                );
                return;
            }
        };

        match serde_json::from_slice::<crate::model::CatalogDto>(&bytes) {
            Ok(dto) => {
                let n = engine.apply_catalog(dto.games);
                engine.push_toast(
                    crate::model::ToastKind::Success,
                    format!("目录已更新 · {n} 款"),
                    Some(format!("源 {base} · schema {}", dto.schema)),
                );
            }
            Err(e) => engine.push_toast(
                crate::model::ToastKind::Error,
                "目录解析失败",
                Some(e.to_string()),
            ),
        }
    });
}

/// Dev self-check: run the REAL Rust CAS runtime either against a `packBuild`
/// repository on disk (LocalFetcher) or over HTTP (HttpFetcher), streaming
/// progress onto the task sheet.
///
/// `repo_dir` empty resolves the generated fixture repository ({workspace}/
/// packages/cas-core-rs/tests/fixtures/repo); trust is read from the vectors
/// file next to it (dev-only key material, never shipped).
/// `base_url` non-empty switches the wire to HTTP.
#[tauri::command]
pub fn cas_selfinstall(
    engine: State<'_, Arc<Engine>>,
    repo_dir: Option<String>,
    base_url: Option<String>,
    app_id: Option<String>,
) {
    use cas_core_rs::client_runtime::{install, Phase as CasPhase, InstallTask, LocalFetcher};
    use cas_core_rs::store::CasStore;
    use cas_core_rs::trust::TrustStore;

    let http_base = base_url.filter(|s| !s.trim().is_empty());
    let engine = Arc::clone(&engine);
    let repo = repo_dir
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from("..\\..\\packages\\cas-core-rs\\tests\\fixtures\\repo")
        });
    let app_id = app_id.unwrap_or_else(|| "1001".into());
    let dest = crate::config::install_root();

    engine.dev_task_begin();

    std::thread::spawn(move || {
        let run_engine = Arc::clone(&engine);
        let run = move || -> Result<String, String> {
            let vectors_path = repo
                .parent()
                .map(|p| p.join("vectors.json"))
                .ok_or_else(|| "fixture repo has no parent".to_string())?;
            let vectors: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(&vectors_path).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let hex_key = vectors["pubRawHex"].as_str().ok_or("vectors: pubRawHex")?;
            let key_id = vectors["keyId"].as_str().ok_or("vectors: keyId")?.to_string();
            let mut raw = [0u8; 32];
            for (i, pair) in hex_key.as_bytes().chunks(2).enumerate() {
                raw[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
            }
            let trust = TrustStore::from_raw(&[(key_id, raw)]);

            let store_root = std::env::var("LOCALAPPDATA")
                .map(|d| PathBuf::from(d).join("Stellar").join("cas-store"))
                .map_err(|e| e.to_string())?;
            let store = CasStore::open(&store_root).map_err(|e| e.to_string())?;
            let http_base2 = http_base.clone();
            let fetcher: &dyn cas_core_rs::client_runtime::Fetcher = match http_base2 {
                Some(ref url) => &cas_core_rs::client_runtime::HttpFetcher::new(url),
                None => &LocalFetcher::new(&repo),
            };

            let eng = Arc::clone(&run_engine);
            let on_event = move |e: cas_core_rs::client_runtime::InstallEvent| {
                let phase = match e.phase {
                    CasPhase::Manifest => crate::model::Phase::Manifest,
                    CasPhase::Downloading => crate::model::Phase::Downloading,
                    CasPhase::Materialize => crate::model::Phase::Materialize,
                    CasPhase::Ready => crate::model::Phase::Ready,
                    CasPhase::Paused => crate::model::Phase::Paused,
                    CasPhase::Failed => crate::model::Phase::Failed,
                };
                eng.dev_task_progress(
                    e.done_bytes,
                    e.total_bytes,
                    e.chunks_done as u64,
                    e.chunks_total as u64,
                    0,
                    phase,
                );
            };

            let result = install(
                fetcher,                &InstallTask {
                    app_id: &app_id,
                    build_id: None,
                    dest: &dest,
                    force: false,
                    concurrency: 8,
                },
                &store,
                &trust,
                &on_event,
            )
            .map_err(|e| e.to_string())?;

            Ok(format!(
                "build {} → {} · 传输 {} · 分块 {} 下载 / {} 复用 · 用时 {} ms",
                result.manifest.build_id,
                dest.display(),
                crate::model::fmt_bytes(result.stats.wire_bytes),
                result.stats.chunks_downloaded,
                result.stats.chunks_reused,
                result.stats.ms
            ))
        };

        match run() {
            Ok(note) => engine.dev_task_finish(note),
            Err(e) => engine.dev_task_fail(e),
        }
    });
}