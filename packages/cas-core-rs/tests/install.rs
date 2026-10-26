//! Real install runs against the Node-generated repository in
//! `tests/fixtures/repo` via LocalFetcher — the same signed manifest, chunks
//! and store logic a production install would use, minus the HTTP layer.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

use cas_core_rs::client_runtime::{install, verify_installed, Fetcher, HttpFetcher, InstallEvent, InstallTask, LocalFetcher, Phase};
use cas_core_rs::store::CasStore;
use cas_core_rs::trust::TrustStore;

mod common;

fn fix() -> String {
    format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"))
}

fn unique_tmp(tag: &str) -> PathBuf {
    let base = std::env::temp_dir();
    let dir = base.join(format!("cas-it-{}-{}-{}", tag, std::process::id(), std::time::SystemTime::now().elapsed().unwrap_or_default().subsec_nanos()));
    fs::create_dir_all(&dir).expect("tmp");
    dir
}

fn pinned_trust() -> TrustStore {
    let vectors = fs::read_to_string(format!("{}/vectors.json", fix())).expect("vectors");
    let json: serde_json::Value = serde_json::from_str(&vectors).expect("vectors json");
    let hex_str = json["pubRawHex"].as_str().expect("pubRawHex");
    let mut raw = [0u8; 32];
    for (i, pair) in hex_str.as_bytes().chunks(2).enumerate() {
        raw[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
    }
    let key_id = json["keyId"].as_str().unwrap().to_string();
    TrustStore::from_raw(&[(key_id, raw)])
}

#[test]
fn fresh_install_downloads_everything_and_lands_intact() {
    let trust = pinned_trust();
    let store_root = unique_tmp("store");
    let dest = unique_tmp("dest");
    let store = CasStore::open(&store_root).expect("store");
    let fetcher = LocalFetcher::new(Path::new(&fix()).join("repo").as_path());

    let events: Arc<Mutex<Vec<InstallEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let result = install(
        &fetcher,
        &InstallTask {
            app_id: "1001",
            build_id: None,
            dest: &dest,
            force: false,
            concurrency: 8,
        },
        &store,
        &trust,
        &move |e: InstallEvent| sink.lock().unwrap().push(e),
    )
    .expect("install");

    assert!(!result.up_to_date);
    let manifest = &result.manifest;
    assert_eq!(manifest.app_id, "1001");

    // every chunk had to hit the wire on a fresh install
    assert_eq!(result.stats.chunks_reused, 0);
    assert_eq!(result.stats.chunks_total, manifest.chunks.len());
    assert_eq!(result.stats.chunks_downloaded, manifest.chunks.len());
    assert_eq!(result.stats.files, manifest.files.len());
    assert!(result.stats.wire_bytes > 0);
    assert_eq!(result.stats.saved_bytes, 0);

    // materialized files land with correct content
    assert!(verify_installed(&dest, manifest).is_empty(), "installed files must hash clean");
    for f in &manifest.files {
        assert!(dest.join(&f.path).is_file(), "missing {}", f.path);
    }

    // progress was reported through every phase
    let phases: Vec<Phase> = events.lock().unwrap().iter().map(|e| e.phase).collect();
    assert!(phases.contains(&Phase::Manifest), "no manifest phase event");
    assert!(phases.contains(&Phase::Downloading), "no download events");
    assert!(phases.contains(&Phase::Materialize), "no materialize events");
    assert!(phases.contains(&Phase::Ready), "no ready event");

    // ...and the store now knows the build
    let rec = store.install("1001").expect("install row").expect("present");
    assert_eq!(rec.build_id, manifest.build_id);

    // cleanup
    fs::remove_dir_all(&store_root).ok();
    fs::remove_dir_all(&dest).ok();
}

#[test]
fn reinstall_and_repair_cost_zero_wire_bytes() {
    let trust = pinned_trust();
    let store_root = unique_tmp("store2");
    let dest = unique_tmp("dest2");
    let store = CasStore::open(&store_root).expect("store");
    let fetcher = LocalFetcher::new(Path::new(&fix()).join("repo").as_path());
    let task = InstallTask {
        app_id: "1001",
        build_id: None,
        dest: &dest,
        force: false,
        concurrency: 8,
    };

    install(&fetcher, &task, &store, &trust, &|_| {}).expect("first");

    // 1. plain re-run is a no-op
    let again = install(&fetcher, &task, &store, &trust, &|_| {}).expect("again");
    assert!(again.up_to_date, "identical install must short-circuit");

    // 2. corrupt one installed file (same size on disk) -> fast path notices
    //    nothing, so repair goes through `force` and rebuilds FROM THE CACHE
    let manifest = &again.manifest;
    let victim = dest.join(&manifest.files[1].path);
    let len = fs::metadata(&victim).unwrap().len();
    let garbage = vec![0x5Au8; len as usize];
    fs::write(&victim, &garbage).expect("corrupt");

    let bad = verify_installed(&dest, manifest);
    assert_eq!(bad.len(), 1, "exactly one file should be flagged");

    let repair_task = InstallTask { force: true, ..task };
    let repair = install(&fetcher, &repair_task, &store, &trust, &|_| {}).expect("repair");
    assert_eq!(repair.stats.wire_bytes, 0, "repair must not hit the wire: chunks are already in the store");
    assert!(repair.stats.wire_bytes == 0);
    assert!(verify_installed(&dest, manifest).is_empty(), "repair restores the file");

    // 3. dropping a chunk from the store makes the next run refetch exactly one
    let usage = store.usage().expect("usage");
    assert!(usage.chunks > 0);
    let mut had_missing = false;
    for id in manifest.chunks.keys() {
        let meta = store.meta(id).expect("meta").expect("row");
        let p = store.path_for(&meta.id, &meta.enc);
        if p.is_file() {
            fs::remove_file(&p).expect("remove");
            had_missing = true;
            break;
        }
    }
    assert!(had_missing);
    let forced = InstallTask { force: true, ..task };
    let refetched = install(&fetcher, &forced, &store, &trust, &|_| {}).expect("refetch");
    assert_eq!(refetched.stats.chunks_downloaded, 1, "exactly the removed chunk is refetched");

    fs::remove_dir_all(&store_root).ok();
    fs::remove_dir_all(&dest).ok();
}

#[test]
fn tampered_wire_chunk_is_rejected_before_landing() {
    let store_root = unique_tmp("store3");
    let store = CasStore::open(&store_root).expect("store");

    let payload = b"definitely the real chunk content".to_vec();
    let id = cas_core_rs::chunker::sha256_hex(&payload);

    // wrong bytes for the same declared size must not enter the store
    assert!(store
        .put_from_wire(&id, &vec![b'X'; payload.len()], "raw", payload.len() as u64)
        .is_err());
    assert!(!store.has(&id), "rejected chunk must not appear in the cache");

    // correct bytes round-trip
    store.put_from_wire(&id, &payload, "raw", payload.len() as u64).expect("put");
    assert_eq!(store.read_plain(&id).expect("read"), payload);

    // gc with no installs reclaims it
    let before = store.usage().expect("usage before");
    let reclaimed = store.gc().expect("gc");
    assert_eq!(reclaimed.chunks, before.chunks);
    assert!(!store.has(&id), "unreferenced chunk must be collected");

    fs::remove_dir_all(&store_root).ok();
}

#[test]
fn http_fetcher_shapes_real_urls() {
    // no server here; just confirm the URL building is origin-relative and
    // that failures come back as io errors rather than panics
    let f = HttpFetcher::new("http://127.0.0.1:9/");
    let err = f
        .fetch("/objects/x")
        .err()
        .expect("must fail to connect");
    assert!(err.to_string().contains("http://127.0.0.1:9/objects/x"), "message should carry the URL");
}
/// The full wire: a real HTTP man-in-nothing server (same URL shape as the
/// CDN), HttpFetcher, the signed manifest — proving production transport
/// end to end with zero special-casing in the install code.
#[test]
fn install_over_real_http_socket() {
    let repo = Path::new(&fix()).join("repo");
    let server = common::spawn(&repo);

    let trust = pinned_trust();
    let store_root = unique_tmp("store-http");
    let dest = unique_tmp("dest-http");
    let store = CasStore::open(&store_root).expect("store");

    let result = install(
        &HttpFetcher::new(&server.base),
        &InstallTask {
            app_id: "1001",
            build_id: None,
            dest: &dest,
            force: false,
            concurrency: 8,
        },
        &store,
        &trust,
        &|_| {},
    )
    .expect("http install");

    assert!(!result.up_to_date);
    assert_eq!(result.stats.chunks_downloaded, result.manifest.chunks.len());
    assert!(result.stats.wire_bytes > 0);
    assert!(verify_installed(&dest, &result.manifest).is_empty());

    // second run over HTTP: same treatment as local — no refetch
    let again = install(
        &HttpFetcher::new(&server.base),
        &InstallTask {
            app_id: "1001",
            build_id: None,
            dest: &dest,
            force: false,
            concurrency: 8,
        },
        &store,
        &trust,
        &|_| {},
    )
    .expect("second run");
    assert!(again.up_to_date);

    fs::remove_dir_all(&store_root).ok();
    fs::remove_dir_all(&dest).ok();
}

fn _sig_len_note() {
    // base64 ED25519 sigs are 88 chars; keep the engine import referenced
    let _ = B64.decode("AAAA");
}
