//! The install/update state machine. Mirrors `packages/cas-core/src/client.js`
//! with two differences at this stage:
//!
//!   - the wire is abstracted behind a `Fetcher` (HTTP in production, local
//!     files for tests and dev self-checks);
//!   - progress is reported through `InstallEvent`s instead of logs — the
//!     Tauri runtime maps them straight onto the UI task sheet.
//!
//! Invariants carried over from the reference (all tested):
//!   * the manifest is verified against pinned keys BEFORE parsing;
//!   * every chunk is re-hashed after decompression (hostile CDN mode);
//!   * each materialized file is hashed, then atomically renamed;
//!   * entrypoint is written last, so a half-finished install can't launch;
//!   * resume is inherent — chunks already in the store are not refetched;
//!   * repair (`force`) rebuilds from the cache with 0 wire bytes.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::chunker::sha256_hex;
use crate::manifest::{FileEntry, Manifest};
use crate::store::CasStore;
use crate::trust::TrustStore;

/* ── wire transport ─────────────────────────────────────────── */

pub trait Fetcher: Send + Sync {
    /// `path` is the resource path on the origin (`apps/1001/latest.json`,
    /// `apps/1001/builds/x/manifest.json`, `objects/<sha256>`).
    fn fetch(&self, path: &str) -> std::io::Result<Vec<u8>>;
}

/// Production transport. `base` is the CDN origin without a trailing slash.
pub struct HttpFetcher {
    agent: ureq::Agent,
    base: String,
}
impl HttpFetcher {
    pub fn new(base: &str) -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(45))
                .build(),
            base: base.trim_end_matches('/').to_string(),
        }
    }
}

impl Fetcher for HttpFetcher {
    fn fetch(&self, path: &str) -> std::io::Result<Vec<u8>> {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .agent
            .get(&url)
            .call()
            .map_err(|e| std::io::Error::other(format!("{url}: {e}")))?;
        let mut reader = resp.into_reader();
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf)?;
        Ok(buf)
    }
}

/// Dev/test transport against a `packBuild` repository on disk. Same URL
/// shape as the HTTP one, so the client code cannot tell the difference.
pub struct LocalFetcher {
    repo: PathBuf,
}

impl LocalFetcher {
    pub fn new(repo: &Path) -> Self {
        Self { repo: repo.to_path_buf() }
    }
}

impl Fetcher for LocalFetcher {
    fn fetch(&self, path: &str) -> std::io::Result<Vec<u8>> {
        // A rooted "/apps" would otherwise replace the whole base path on
        // Windows; always treat resource paths as relative.
        let rel = path.trim_start_matches('/');
        // Object URLs are flat (/objects/<sha256>) while the store is
        // bucketed by the first two hex chars — same as the HTTP server.
        let target = match rel.strip_prefix("objects/") {
            Some(id) if id.len() == 64 => {
                self.repo.join("objects").join(&id[..2]).join(id)
            }
            _ => self.repo.join(rel),
        };
        fs::read(&target)
            .map_err(|e| std::io::Error::new(e.kind(), format!("{}: {e}", target.display())))
    }
}

/* ── events & results ──────────────────────────────────────── */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Manifest,
    Downloading,
    Materialize,
    Ready,
    Paused,
    Failed,
}

#[derive(Clone, Debug)]
pub struct InstallEvent {
    pub phase: Phase,
    /// What this build still has to move over the wire (CAS diff), not the
    /// size of the whole build.
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub wire_bytes: u64,
    pub chunks_total: usize,
    pub chunks_done: usize,
    pub files_done: usize,
}

impl InstallEvent {
    /// Fraction complete on the *transfer* dimension (chunk-level progress).
    pub fn percent(&self) -> f64 {
        if self.chunks_total == 0 {
            return 100.0;
        }
        (self.chunks_done as f64 / self.chunks_total as f64) * 100.0
    }
}

#[derive(Clone, Debug, Default)]
pub struct InstallStats {
    pub chunks_total: usize,
    pub chunks_downloaded: usize,
    pub chunks_reused: usize,
    pub plain_bytes: u64,
    pub wire_bytes: u64,
    pub saved_bytes: u64,
    pub requests: u64,
    pub retries: u64,
    pub files: usize,
    pub ms: u128,
}

pub struct InstallResult {
    pub manifest: Manifest,
    pub stats: InstallStats,
    pub up_to_date: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("manifest: {0}")]
    Manifest(#[from] crate::manifest::ManifestError),
    #[error("store: {0}")]
    Store(#[from] crate::store::StoreError),
    #[error("trust: {0}")]
    Trust(#[from] crate::trust::TrustError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("install: {0}")]
    Client(String),
    #[error("worker: {0}")]
    Worker(String),
}

pub type Result<T> = std::result::Result<T, InstallError>;

pub struct InstallTask<'a> {
    pub app_id: &'a str,
    /// `None` resolves the `latest` pointer.
    pub build_id: Option<&'a str>,
    pub dest: &'a Path,
    /// Re-materialize from the local store even when the install looks intact.
    pub force: bool,
    pub concurrency: usize,
}

/* ── orchestration ─────────────────────────────────────────── */

pub fn install<F: Fetcher + ?Sized>(
    fetcher: &F,
    task: &InstallTask<'_>,
    store: &CasStore,
    trust: &TrustStore,
    on_event: &(dyn Fn(InstallEvent) + Sync),
) -> Result<InstallResult> {
    let started = Instant::now();

    // 1. manifest (+ sig), verify BEFORE parsing. keyId inside the payload is
    //    untrusted; verification tries every pinned key instead.
    let pointer = fetch_json(fetcher, &format!("/apps/{}/latest.json", task.app_id))?;
    let build_id = match task.build_id {
        Some(b) => b.to_string(),
        None => pointer
            .get("buildId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| InstallError::Client("latest pointer without buildId".into()))?
            .to_string(),
    };
    emit(on_event, Phase::Manifest, 0, 0, 0, 0, 0, 0);

    let manifest_path = format!("/apps/{app}/builds/{build}/manifest.json", app = task.app_id, build = build_id);
    let bytes = fetcher.fetch(&manifest_path)?;
    let sig = String::from_utf8(fetcher.fetch(&format!("{manifest_path}.sig"))?)
        .map_err(|e| InstallError::Client(format!("sig file is not utf8: {e}")))?
        .trim()
        .to_string();
    let signer = trust
        .verify_any(&bytes, &sig)?
        .ok_or_else(|| InstallError::Client("manifest signature verification FAILED".into()))?;

    let manifest = Manifest::parse(&bytes)?;
    if manifest.app_id != task.app_id {
        return Err(InstallError::Client(format!(
            "appId mismatch: {} != {}",
            manifest.app_id, task.app_id
        )));
    }
    if manifest.key_id != signer {
        return Err(InstallError::Client("signer key id mismatch".into()));
    }
    manifest.validate()?;

    // 2. diff against the local chunk store
    let mut all: BTreeMap<String, u64> = BTreeMap::new(); // id -> plain size
    let mut total_plain = 0u64;
    for f in &manifest.files {
        total_plain += f.size;
        for id in &f.chunks {
            let size = manifest.chunks.get(id).map(|m| m.size).unwrap_or(0);
            all.entry(id.clone()).or_insert(size);
        }
    }
    let (needed_ids, _reused_plain) = store.diff(&all)?;
    let chunks_total = all.len();
    let needed_plain: u64 = needed_ids
        .iter()
        .filter_map(|id| all.get(id).map(|s| *s))
        .sum();

    // 3. same build + intact files -> nothing to do
    if !task.force {
        if let Some(rec) = store.install(task.app_id)? {
            if rec.build_id == manifest.build_id
                && rec.root == task.dest.to_string_lossy()
                && files_look_intact(task.dest, &manifest)
            {
                return Ok(InstallResult {
                    stats: InstallStats {
                        chunks_total,
                        chunks_downloaded: 0,
                        chunks_reused: chunks_total,
                        plain_bytes: total_plain,
                        wire_bytes: 0,
                        saved_bytes: total_plain,
                        ms: started.elapsed().as_millis(),
                        files: 0,
                        ..Default::default()
                    },
                    manifest,
                    up_to_date: true,
                });
            }
        }
    }

    // 4. download everything the store is missing (chunk-level resume is
    //    inherent: completed chunks were already registered)
    let live = Arc::new(Live {
        done_chunks: AtomicUsize::new(0),
        done_bytes: AtomicU64::new(0),
        wire_bytes: AtomicU64::new(0),
        retries: AtomicU64::new(0),
        requests: AtomicU64::new(0),
    });
    let failure: Arc<Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));

    std::thread::scope(|scope| -> Result<()> {
        let workers = task.concurrency.clamp(1, 16);
        let remaining = Arc::new(AtomicUsize::new(workers));
        for _ in 0..workers {
            let needed = needed_ids.clone();
            let live = live.clone();
            let failure = failure.clone();
            let remaining = remaining.clone();
            let manifest = &manifest;
            scope.spawn(move || {
                for id in &needed {
                    if failure.lock().unwrap().is_some() {
                        break;
                    }
                    let meta = manifest.chunks.get(id).expect("chunk meta validated");
                    let mut attempt: u32 = 0;
                    loop {
                        live.requests.fetch_add(1, Ordering::Relaxed);
                        let outcome = fetcher
                            .fetch(&format!("/objects/{id}"))
                            .and_then(|body| {
                                let wire = body.len() as u64;
                                store
                                    .put_from_wire(id, &body, &meta.enc, meta.size)
                                    .map(|_| wire)
                                    .map_err(|e| std::io::Error::other(e.to_string()))
                            });

                        match outcome {
                            Ok(wire) => {
                                live.done_chunks.fetch_add(1, Ordering::Relaxed);
                                live.done_bytes.fetch_add(meta.size, Ordering::Relaxed);
                                live.wire_bytes.fetch_add(wire, Ordering::Relaxed);
                                break;
                            }
                            Err(e) => {
                                attempt += 1;
                                live.retries.fetch_add(1, Ordering::Relaxed);
                                if attempt > 4 {
                                    let mut fail = failure.lock().unwrap();
                                    if fail.is_none() {
                                        *fail = Some(format!("chunk {id} failed: {e}"));
                                    }
                                    break;
                                }
                                let backoff = std::cmp::min(2000, 100 * 2u64.pow(attempt));
                                std::thread::sleep(Duration::from_millis(backoff));
                            }
                        }
                    }
                }
                remaining.fetch_sub(1, Ordering::SeqCst);
            });
        }

        // The parent polls: chunk workers only touch atomics (no callback
        // across the thread boundary), the parent publishes UI events.
        loop {
            if remaining.load(Ordering::SeqCst) == 0 {
                break;
            }
            emit(
                on_event,
                Phase::Downloading,
                needed_plain,
                live.done_bytes.load(Ordering::Relaxed),
                live.wire_bytes.load(Ordering::Relaxed),
                chunks_total,
                live.done_chunks.load(Ordering::Relaxed),
                0,
            );
            if failure.lock().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        Ok(())
    })?;

    if let Some(err) = failure.lock().unwrap().take() {
        return Err(InstallError::Worker(err));
    }

    emit(
        on_event,
        Phase::Downloading,
        needed_plain,
        live.done_bytes.load(Ordering::Relaxed),
        live.wire_bytes.load(Ordering::Relaxed),
        chunks_total,
        needed_ids.len(),
        0,
    );

    // 5. materialize: entrypoint written last (half-built installs can't launch)
    let files = materialize(task.dest, &manifest, store, &|done, _total| {
        emit(
            on_event,
            Phase::Materialize,
            needed_plain,
            live.done_bytes.load(Ordering::Relaxed),
            live.wire_bytes.load(Ordering::Relaxed),
            chunks_total,
            needed_ids.len(),
            done,
        );
    })?;

    // 6. bookkeeping
    store.begin_install(task.app_id)?;
    for f in &manifest.files {
        store.record_file(task.app_id, &f.path, &f.sha256, f.size, &f.chunks)?;
    }
    store.commit_install(&crate::store::InstallRecord {
        app_id: task.app_id.to_string(),
        build_id: manifest.build_id.clone(),
        root: task.dest.to_string_lossy().to_string(),
        manifest_sha: sha256_hex(&bytes),
        installed_at: iso8601_now(),
    })?;

    emit(
        on_event,
        Phase::Ready,
        needed_plain,
        total_plain,
        live.wire_bytes.load(Ordering::Relaxed),
        chunks_total,
        chunks_total,
        files,
    );

    Ok(InstallResult {
        stats: InstallStats {
            chunks_total,
            chunks_downloaded: needed_ids.len(),
            chunks_reused: chunks_total - needed_ids.len(),
            plain_bytes: total_plain,
            wire_bytes: live.wire_bytes.load(Ordering::Relaxed),
            saved_bytes: total_plain - needed_plain,
            requests: live.requests.load(Ordering::Relaxed),
            retries: live.retries.load(Ordering::Relaxed),
            files,
            ms: started.elapsed().as_millis(),
        },
        manifest,
        up_to_date: false,
    })
}

/* ── per-file materialization ───────────────────────────────── */

/// Hash every installed file against the manifest. Byte-for-byte authoritative
/// check; the fast-path (mtime/size) shortcut lives in `files_look_intact`.
pub fn verify_installed(dest: &Path, manifest: &Manifest) -> Vec<String> {
    let mut bad = Vec::new();
    for f in &manifest.files {
        let p = dest.join(rel_path(&f.path));
        match fs::read(&p) {
            Ok(data) => {
                if sha256_hex(&data) != f.sha256 {
                    bad.push(f.path.clone());
                }
            }
            Err(_) => bad.push(format!("{} (missing)", f.path)),
        }
    }
    bad
}

pub fn materialize(
    dest: &Path,
    manifest: &Manifest,
    store: &CasStore,
    on_file: &dyn Fn(usize, usize),
) -> Result<usize> {
    let mut ordered: Vec<&FileEntry> = manifest.files.iter().collect();
    if let Some(ep) = &manifest.entrypoint {
        let ep = ep.clone();
        ordered.sort_by_key(|f| f.path == ep);
    }

    let mut written = 0usize;
    for f in &ordered {
        let target = dest.join(rel_path(&f.path));
        fs::create_dir_all(target.parent().unwrap())?;
        let tmp = target.with_extension("cas-part");

        let mut out = fs::File::create(&tmp)?;
        let mut hasher = crate::manifest::FileHasher::new();
        for id in &f.chunks {
            let plain = store.read_plain(id)?;
            hasher.update(&plain);
            out.write_all(&plain)?;
        }
        out.flush()?;
        drop(out);

        if hasher.finish_hex() != f.sha256 {
            let _ = fs::remove_file(&tmp);
            return Err(InstallError::Client(format!(
                "file hash mismatch: {}",
                f.path
            )));
        }
        let _ = fs::remove_file(&target);
        fs::rename(&tmp, &target)?;
        written += 1;
        on_file(written, ordered.len());
    }

    if let Some(ep) = &manifest.entrypoint {
        if !dest.join(rel_path(ep)).is_file() {
            return Err(InstallError::Client(format!("entrypoint missing: {ep}")));
        }
    }
    Ok(written)
}

/* ── helpers ────────────────────────────────────────────────── */

struct Live {
    done_chunks: AtomicUsize,
    done_bytes: AtomicU64,
    wire_bytes: AtomicU64,
    retries: AtomicU64,
    requests: AtomicU64,
}

fn emit<F>(
    on_event: &F,
    phase: Phase,
    total_bytes: u64,
    done_bytes: u64,
    wire_bytes: u64,
    chunks_total: usize,
    chunks_done: usize,
    files_done: usize,
) where
    F: Fn(InstallEvent) + ?Sized,
{
    on_event(InstallEvent {
        phase,
        total_bytes,
        done_bytes,
        wire_bytes,
        chunks_total,
        chunks_done,
        files_done,
    });
}

fn fetch_json<F: Fetcher + ?Sized>(f: &F, url: &str) -> Result<serde_json::Value> {
    let bytes = f.fetch(url)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn files_look_intact(dest: &Path, manifest: &Manifest) -> bool {
    // Fast path: size match on every file. A full re-hash runs on demand
    // through `verify_installed`.
    manifest.files.iter().all(|f| {
        fs::metadata(dest.join(rel_path(&f.path)))
            .map(|m| m.len() == f.size)
            .unwrap_or(false)
    })
}

/// Split a manifest path into segments and join it. `assert_safe_path` was
/// already applied by `validate()`; this is defense in depth.
fn rel_path(p: &str) -> PathBuf {
    debug_assert!(!p.split('/').any(|s| s == ".."));
    p.split('/').collect::<PathBuf>()
}

#[allow(dead_code)]
fn unused_marker() {}

fn iso8601_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs} (unix secs)")
}
