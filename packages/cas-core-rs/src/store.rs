//! Client-side content-addressed store. Mirrors `packages/cas-core/src/store.js`.
//!
//! Chunks are keyed by sha256 of their *plaintext*; on disk they keep whatever
//! encoding arrived over the wire, so relaunching never recompresses.
//! Refcounts are derived from the `file_chunk` table, so GC is a single query
//! plus file unlinking and multiple installs share one cache.

use rusqlite::{Connection, OptionalExtension};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const ZSTD_LEVEL: i32 = 3;
/// Assets are often already compressed; don't pay CPU for ~0 gain.
const COMPRESS_GAIN: f64 = 0.97;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("chunk {0}: {1}")]
    Corruption(String, String),
    #[error("chunk not in store: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Clone, Debug)]
pub struct ChunkMetaRow {
    pub id: String,
    pub size: u64,
    pub wire: u64,
    pub enc: String,
}

#[derive(Clone, Debug)]
pub struct InstallRecord {
    pub app_id: String,
    pub build_id: String,
    pub root: String,
    pub manifest_sha: String,
    pub installed_at: String,
}

#[derive(Clone, Debug, Default)]
pub struct Usage {
    pub chunks: u64,
    pub bytes: u64,
}

pub struct CasStore {
    root: PathBuf,
    conn: Mutex<Connection>,
}

impl CasStore {
    pub fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root.join("objects"))?;
        fs::create_dir_all(root.join("tmp"))?;
        let conn = Connection::open(root.join("index.sqlite"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS chunk (
               id TEXT PRIMARY KEY, size INTEGER NOT NULL, wire INTEGER NOT NULL, enc TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS install (
               app_id TEXT PRIMARY KEY, build_id TEXT NOT NULL, root TEXT NOT NULL,
               manifest_sha TEXT NOT NULL, installed_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS file (
               app_id TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL,
               size INTEGER NOT NULL, PRIMARY KEY (app_id, path)
             );
             CREATE TABLE IF NOT EXISTS file_chunk (
               app_id TEXT NOT NULL, path TEXT NOT NULL, ord INTEGER NOT NULL,
               chunk_id TEXT NOT NULL, PRIMARY KEY (app_id, path, ord)
             );
             CREATE INDEX IF NOT EXISTS idx_file_chunk_chunk ON file_chunk (chunk_id);",
        )?;
        Ok(Self { root: root.to_path_buf(), conn: Mutex::new(conn) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path_for(&self, id: &str, enc: &str) -> PathBuf {
        self.root.join("objects").join(&id[..2]).join(format!("{id}.{enc}"))
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.root.join("tmp")
    }

    /* ── chunk operations ─────────────────────────────────────── */

    pub fn meta(&self, id: &str) -> Result<Option<ChunkMetaRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id, size, wire, enc FROM chunk WHERE id = ?1")?;
        let mut rows = stmt.query([id])?;
        Ok(match rows.next()? {
            Some(r) => Some(ChunkMetaRow {
                id: r.get(0)?,
                size: r.get(1)?,
                wire: r.get(2)?,
                enc: r.get(3)?,
            }),
            None => None,
        })
    }

    pub fn has(&self, id: &str) -> bool {
        self.meta(id)
            .map(|m| m.map(|m_| self.path_for(&m_.id, &m_.enc).is_file()).unwrap_or(false))
            .unwrap_or(false)
    }

    pub fn known_chunks(&self) -> Result<std::collections::HashSet<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM chunk")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Decompressed plaintext bytes for a stored chunk.
    pub fn read_plain(&self, id: &str) -> Result<Vec<u8>> {
        let m = self.meta(id)?.ok_or_else(|| StoreError::NotFound(id.to_string()))?;
        let raw = fs::read(self.path_for(&m.id, &m.enc))?;
        let plain = match m.enc.as_str() {
            "zstd" => zstd::stream::decode_all(raw.as_slice())?,
            "raw" => raw,
            other => return Err(StoreError::Corruption(id.to_string(), format!("unknown enc {other}"))),
        };
        Ok(plain)
    }

    pub fn write_plain(&self, plain: &[u8]) -> Result<()> {
        let id = crate::chunker::sha256_hex(plain);
        let compressed = zstd::stream::encode_all(std::io::Cursor::new(plain), ZSTD_LEVEL)?;
        let (body, enc) = if (compressed.len() as f64) < plain.len() as f64 * COMPRESS_GAIN {
            (compressed, "zstd")
        } else {
            (plain.to_vec(), "raw")
        };
        self.write_object(&id, &body, enc, plain.len() as u64)
    }

    /// Accept raw wire bytes (already-encoded body). Verifies sha256 *after*
    /// decompression, so a hostile CDN cannot inject content into the store.
    pub fn put_from_wire(&self, id: &str, body: &[u8], enc: &str, expected_size: u64) -> Result<u64> {
        let plain = match enc {
            "zstd" => zstd::stream::decode_all(body)?,
            "raw" => body.to_vec(),
            other => return Err(StoreError::Corruption(id.to_string(), format!("unknown enc {other}"))),
        };
        if plain.len() as u64 != expected_size {
            return Err(StoreError::Corruption(
                id.to_string(),
                format!("size {} != {expected_size}", plain.len()),
            ));
        }
        let got = crate::chunker::sha256_hex(&plain);
        if got != id {
            return Err(StoreError::Corruption(id.to_string(), format!("hash mismatch {got}")));
        }
        self.write_object(id, body, enc, expected_size)?;
        Ok(body.len() as u64)
    }

    fn write_object(&self, id: &str, body: &[u8], enc: &str, plain_size: u64) -> Result<()> {
        let dest = self.path_for(id, enc);
        fs::create_dir_all(dest.parent().unwrap())?;
        let tmp = self
            .tmp_dir()
            .join(format!("{id}.{}.part", std::process::id()));
        fs::write(&tmp, body)?;
        // rename fails if dest exists on some platforms; clean first
        let _ = fs::remove_file(&dest);
        fs::rename(&tmp, &dest)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO chunk (id, size, wire, enc) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, plain_size, body.len() as u64, enc],
        )?;
        drop(conn);
        Ok(())
    }

    /* ── install bookkeeping ──────────────────────────────────── */

    /// Drop the previous plan for an app before recording a new one.
    pub fn begin_install(&self, app_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM file WHERE app_id = ?1", [app_id])?;
        conn.execute("DELETE FROM file_chunk WHERE app_id = ?1", [app_id])?;
        Ok(())
    }

    pub fn record_file(
        &self,
        app_id: &str,
        path: &str,
        file_sha: &str,
        size: u64,
        chunk_ids: &[String],
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO file (app_id, path, sha256, size) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![app_id, path, file_sha, size],
        )?;
        for (ord, chunk_id) in chunk_ids.iter().enumerate() {
            conn.execute(
                "INSERT OR REPLACE INTO file_chunk (app_id, path, ord, chunk_id) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![app_id, path, ord as i64, chunk_id],
            )?;
        }
        Ok(())
    }

    pub fn commit_install(&self, rec: &InstallRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO install (app_id, build_id, root, manifest_sha, installed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![rec.app_id, rec.build_id, rec.root, rec.manifest_sha, rec.installed_at],
        )?;
        Ok(())
    }

    pub fn install(&self, app_id: &str) -> Result<Option<InstallRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT app_id, build_id, root, manifest_sha, installed_at FROM install WHERE app_id = ?1",
        )?;
        let rec = stmt
            .query_row([app_id], |r| {
                Ok(InstallRecord {
                    app_id: r.get(0)?,
                    build_id: r.get(1)?,
                    root: r.get(2)?,
                    manifest_sha: r.get(3)?,
                    installed_at: r.get(4)?,
                })
            })
            .optional()?;
        Ok(rec)
    }

    pub fn usage(&self) -> Result<Usage> {
        let conn = self.conn.lock().unwrap();
        let (bytes, chunks) = conn.query_row(
            "SELECT COALESCE(SUM(wire), 0), COUNT(*) FROM chunk",
            [],
            |r| Ok((r.get::<_, u64>(0)?, r.get::<_, u64>(1)?)),
        )?;
        Ok(Usage { bytes, chunks })
    }

    /// Delete chunks referenced by no install. Returns reclaimed (chunks, bytes).
    pub fn gc(&self) -> Result<Usage> {
        let conn = self.conn.lock().unwrap();
        let ids: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, enc FROM chunk WHERE id NOT IN (SELECT DISTINCT chunk_id FROM file_chunk)",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let mut bytes: u64 = 0;
        for (id, enc) in &ids {
            let p = self.path_for(id, enc);
            if p.is_file() {
                bytes += fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let _ = fs::remove_file(&p);
            }
        }
        conn.execute(
            "DELETE FROM chunk WHERE id NOT IN (SELECT DISTINCT chunk_id FROM file_chunk)",
            [],
        )?;
        Ok(Usage { chunks: ids.len() as u64, bytes })
    }

    /* ── helpers used by the client ───────────────────────────── */

    /// (chunks already present -> their plaintext bytes count) and the list
    /// of ids still missing, in a deterministic order.
    /// `all` maps chunk id -> plaintext size.
    pub fn diff(&self, all: &BTreeMap<String, u64>) -> Result<(Vec<String>, u64)> {
        let mut needed = Vec::new();
        let mut reused = 0u64;
        for (id, size) in all {
            if self.has(id) {
                reused += size;
            } else {
                needed.push(id.clone());
            }
        }
        Ok((needed, reused))
    }
}
