//! Manifest types + structural validation. Mirrors
//! `packages/cas-core/src/manifest.js` (schema 1, camelCase wire format).
//!
//! The signature covers the exact manifest bytes, so verification happens on
//! the raw payload in `trust` — nothing here parses before that.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid manifest: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, ManifestError>;

pub const SCHEMA: u8 = 1;

pub const PLATFORMS: &[&str] = &[
    "windows-x86_64",
    "windows-arm64",
    "macos-arm64",
    "macos-x86_64",
    "linux-x86_64",
    "android-arm64-v8a",
    "android-x86_64",
];

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMeta {
    pub size: u64,
    pub wire: u64,
    pub enc: String,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub chunks: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u8,
    pub app_id: String,
    pub build_id: String,
    pub platform: String,
    pub version: String,
    pub key_id: String,
    pub created_at: String,
    pub total_size: u64,
    pub wire_size: u64,
    pub entrypoint: Option<String>,
    pub files: Vec<FileEntry>,
    pub chunks: BTreeMap<String, ChunkMeta>,
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        Ok(serde_json::from_slice(bytes)?)
    }

    /// Structural validation. Anything that would let a crafted manifest
    /// write outside the install root or corrupt accounting is rejected here.
    pub fn validate(&self) -> Result<()> {
        if self.schema != SCHEMA {
            return Err(invalid(format!("unsupported schema {}", self.schema)));
        }
        let required: [(&str, &str); 5] = [
            ("app_id", &self.app_id),
            ("build_id", &self.build_id),
            ("platform", &self.platform),
            ("version", &self.version),
            ("key_id", &self.key_id),
        ];
        for (k, v) in required {
            if v.is_empty() {
                return Err(invalid(format!("missing {k}")));
            }
        }
        if !PLATFORMS.contains(&self.platform.as_str()) {
            return Err(invalid(format!("unknown platform {}", self.platform)));
        }

        let mut seen = std::collections::HashSet::new();
        let mut total: u64 = 0;
        for f in &self.files {
            assert_safe_path(&f.path)?;
            if !seen.insert(f.path.clone()) {
                return Err(invalid(format!("duplicate path {}", f.path)));
            }
            if !is_sha256_hex(&f.sha256) {
                return Err(invalid(format!("bad file hash {}", f.path)));
            }
            if f.chunks.is_empty() && f.size > 0 {
                return Err(invalid(format!("empty chunk list {}", f.path)));
            }
            total += f.size;
            for id in &f.chunks {
                let meta = self
                    .chunks
                    .get(id)
                    .ok_or_else(|| invalid(format!("missing chunk {id}")))?;
                if !is_sha256_hex(id) {
                    return Err(invalid(format!("bad chunk id {id}")));
                }
                if !matches!(meta.enc.as_str(), "zstd" | "raw") {
                    return Err(invalid(format!("bad enc {id}")));
                }
            }
        }
        if self.total_size != total {
            return Err(invalid(format!(
                "totalSize {} != {total}",
                self.total_size
            )));
        }
        Ok(())
    }
}

fn invalid(msg: impl Into<String>) -> ManifestError {
    ManifestError::Invalid(msg.into())
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Path checks. Must stay in lockstep with the reference `SAFE_PATH` regex:
/// no leading `/`, no `..` segments, no backslash/NUL, and only word chars,
/// spaces, dots, dashes, slashes and CJK.
pub fn assert_safe_path(p: &str) -> Result<()> {
    if p.is_empty() || p.len() > 512 {
        return Err(invalid("path length"));
    }
    if p.contains('\\') || p.contains('\0') {
        return Err(invalid("path separators"));
    }
    if p.starts_with('/') {
        return Err(invalid("absolute path"));
    }
    for seg in p.split('/') {
        if seg == ".." {
            return Err(invalid("traversal"));
        }
    }
    for c in p.chars() {
        let ok = c.is_ascii_alphanumeric()
            || matches!(c, ' ' | '.' | '_' | '-' | '/')
            || ('\u{4e00}'..='\u{9fa5}').contains(&c);
        if !ok {
            return Err(invalid(format!("bad character {c:?} in path")));
        }
    }
    Ok(())
}

/// File digests, wired for the materializer: streaming sha256 over chunks.
pub struct FileHasher {
    inner: Sha256,
}

impl Default for FileHasher {
    fn default() -> Self {
        Self::new()
    }
}

impl FileHasher {
    #[must_use]
    pub fn new() -> Self {
        Self { inner: Sha256::new() }
    }

    pub fn update(&mut self, chunk: &[u8]) {
        self.inner.update(chunk);
    }

    pub fn finish_hex(self) -> String {
        hex::encode(self.inner.finalize())
    }

    pub fn digest(&mut self) -> [u8; 32] {
        self.inner.clone().finalize().into()
    }

    pub fn reset(&mut self) {
        self.inner = Sha256::new();
    }
}
