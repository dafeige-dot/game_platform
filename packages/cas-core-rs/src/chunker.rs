//! FastCDC chunking. Mirrors `packages/cas-core/src/chunker.js`.
//!
//! The gear table is derived from a fixed seed so that the Node reference,
//! the Rust client and any future Go packer produce identical cut points.

use sha2::{Digest, Sha256};
use std::io::Read;

pub const GEAR_SEED: u32 = 0x9e37_79b9;

pub const MIN_SIZE: usize = 256 * 1024;
pub const NORMAL_SIZE: usize = 1024 * 1024;
pub const MAX_SIZE: usize = 4 * 1024 * 1024;
/// > NORMAL: harder to cut (keeps sizes from collapsing)
pub const MASK_S: u32 = (1 << 21) - 1;
/// >= NORMAL: easier to cut (keeps the average near 1 MiB)
pub const MASK_L: u32 = (1 << 19) - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkRange {
    pub offset: usize,
    pub len: usize,
}

/// Deterministic gear table. Same recurrence as the JS reference:
/// `x ^= x<<13; x ^= x>>>17; x ^= x<<5` on u32.
pub fn gear_table() -> [u32; 256] {
    let mut x = GEAR_SEED;
    let mut table = [0u32; 256];
    for slot in table.iter_mut() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *slot = x;
    }
    table
}

/// Length of the chunk starting at `off`, bounded by the MIN..MAX window.
/// Always >= MIN_SIZE unless the remaining bytes are smaller.
pub fn cut(buf: &[u8], off: usize) -> usize {
    debug_assert!(off < buf.len());
    let avail = buf.len() - off;
    let end = avail.min(MAX_SIZE);
    if end <= MIN_SIZE {
        return avail;
    }

    let normal = NORMAL_SIZE.min(end);
    let gear = gear_table();

    let mut h: u32 = 0;
    for i in MIN_SIZE..normal {
        h = h.wrapping_shl(1).wrapping_add(gear[buf[off + i] as usize]);
        if h & MASK_S == 0 {
            return i + 1;
        }
    }
    let mut h: u32 = 0;
    for i in normal..end {
        h = h.wrapping_shl(1).wrapping_add(gear[buf[off + i] as usize]);
        if h & MASK_L == 0 {
            return i + 1;
        }
    }
    end
}

/// Cut ranges over an entire in-memory buffer (parity with `chunkBuffer`).
pub fn chunk_buffer(buf: &[u8]) -> Vec<ChunkRange> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off < buf.len() {
        if buf.len() - off <= MIN_SIZE {
            out.push(ChunkRange { offset: off, len: buf.len() - off });
            break;
        }
        let len = cut(buf, off);
        out.push(ChunkRange { offset: off, len });
        off += len;
    }
    out
}

/// Chunk *data* over a stream (parity with `chunkStream`): buffers up to a
/// window, cuts, and keeps the remainder; the tail is flushed at EOF.
pub fn chunk_stream<R: Read>(mut reader: R) -> std::io::Result<Vec<Vec<u8>>> {
    let mut out: Vec<Vec<u8>> = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut piece = vec![0u8; 1024 * 1024];

    loop {
        let n = reader.read(&mut piece)?;
        if n == 0 {
            let mut off = 0usize;
            while off < pending.len() {
                if pending.len() - off <= MIN_SIZE {
                    out.push(pending[off..].to_vec());
                    break;
                }
                let len = cut(&pending, off);
                out.push(pending[off..off + len].to_vec());
                off += len;
            }
            break;
        }

        pending.extend_from_slice(&piece[..n]);

        let mut off = 0usize;
        while pending.len() - off > MAX_SIZE {
            let len = cut(&pending, off);
            out.push(pending[off..off + len].to_vec());
            off += len;
        }
        if off > 0 {
            pending = pending.split_off(off);
        }
    }
    Ok(out)
}

pub fn sha256_hex(buf: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(buf);
    hex::encode(h.finalize())
}
