//! Manifest signature verification (Ed25519). The trust root is *pinned*:
//! raw public keys ship with the binary, keyed by `keyId` (sha256 over the
//! SPKI DER encoding, first 32 hex chars — matches `keyIdOf` in the Node
//! reference, so keys generated there verify here unchanged).

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// SPKI DER prefix for an Ed25519 public key (RFC 8410).
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// sha256(SPKI(pub)) as the first 32 hex chars.
#[must_use]
pub fn key_id_of_raw(raw: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(ED25519_SPKI_PREFIX);
    h.update(raw);
    hex::encode(h.finalize()).get(..32).unwrap_or_default().to_string()
}

#[derive(Debug, thiserror::Error)]
pub enum TrustError {
    #[error("bad key material: {0}")]
    Key(String),
    #[error("bad signature encoding: {0}")]
    Signature(String),
}

/// Pin-as-you-go trust store. A real client compiles this table in; dev
/// builds can load JSON — same shape either way.
pub struct TrustStore {
    keys: HashMap<String, VerifyingKey>,
}

impl TrustStore {
    /// `pinned` pairs: (id, raw 32-byte public key).
    pub fn from_raw(pinned: &[(String, [u8; 32])]) -> Self {
        let mut keys = HashMap::new();
        for (id, raw) in pinned {
            if let Ok(vk) = VerifyingKey::from_bytes(raw) {
                keys.insert(id.clone(), vk);
            }
        }
        Self { keys }
    }

    #[must_use]
    pub fn has(&self, id: &str) -> bool {
        self.keys.contains_key(id)
    }

    /// Verify against the key with the given id.
    pub fn verify(&self, bytes: &[u8], signature_b64: &str, key_id: &str) -> Result<bool, TrustError> {
        let Some(vk) = self.keys.get(key_id) else {
            return Ok(false);
        };
        let sig = signature_from_b64(signature_b64)?;
        Ok(vk.verify(bytes, &sig).is_ok())
    }

    /// Try every pinned key; used on the wire where keyId inside the
    /// (unsigned!) manifest cannot be trusted a priori.
    pub fn verify_any(&self, bytes: &[u8], signature_b64: &str) -> Result<Option<String>, TrustError> {
        let sig = signature_from_b64(signature_b64)?;
        for (id, vk) in &self.keys {
            if vk.verify(bytes, &sig).is_ok() {
                return Ok(Some(id.clone()));
            }
        }
        Ok(None)
    }
}

fn signature_from_b64(s: &str) -> Result<Signature, TrustError> {
    let raw = B64
        .decode(s.trim())
        .map_err(|e| TrustError::Signature(e.to_string()))?;
    Signature::from_slice(&raw).map_err(|e| TrustError::Signature(e.to_string()))
}
