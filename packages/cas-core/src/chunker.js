/**
 * FastCDC content-defined chunking.
 *
 * The gear table is generated from a fixed seed so that every implementation
 * (Node reference, Rust client, Go packer) produces byte-identical cut points.
 * Do NOT change GEAR_SEED without bumping the protocol schema: doing so makes
 * every existing manifest incompatible.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const GEAR_SEED = 0x9e3779b9;

export const CHUNK = {
  MIN: 256 * 1024,
  NORMAL: 1024 * 1024,
  MAX: 4 * 1024 * 1024,
  // > NORMAL: harder to cut -> pushes sizes back up
  MASK_S: (1 << 21) - 1,
  // >= NORMAL: easier to cut -> keeps the average near 1 MiB
  MASK_L: (1 << 19) - 1,
};

const GEAR = (() => {
  let x = GEAR_SEED >>> 0;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    t[i] = x;
  }
  return t;
})();

/** Length of the chunk starting at `off`, bounded by [MIN, MAX] of the buffer. */
function cut(buf, off) {
  const avail = buf.length - off;
  const end = Math.min(avail, CHUNK.MAX);
  if (end <= CHUNK.MIN) return avail;

  const normal = Math.min(CHUNK.NORMAL, end);
  let h = 0;
  for (let i = CHUNK.MIN; i < normal; i++) {
    h = ((h << 1) + GEAR[buf[off + i]]) >>> 0;
    if ((h & CHUNK.MASK_S) === 0) return i + 1;
  }
  h = 0;
  for (let i = normal; i < end; i++) {
    h = ((h << 1) + GEAR[buf[off + i]]) >>> 0;
    if ((h & CHUNK.MASK_L) === 0) return i + 1;
  }
  return end;
}

/** Chunk an in-memory buffer. */
export function* chunkBuffer(buf) {
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off <= CHUNK.MIN) {
      yield buf.subarray(off);
      return;
    }
    const n = cut(buf, off);
    yield buf.subarray(off, off + n);
    off += n;
  }
}

/**
 * Chunk a readable stream with a bounded working buffer.
 * Yields Buffers (views, not copies).
 */
export async function* chunkStream(readable) {
  let pending = Buffer.alloc(0);
  for await (const piece of readable) {
    pending = pending.length ? Buffer.concat([pending, piece]) : piece;

    let off = 0;
    // Only cut while we can guarantee MIN..MAX bounds.
    while (pending.length - off > CHUNK.MAX) {
      const n = cut(pending, off);
      yield pending.subarray(off, off + n);
      off += n;
    }
    if (off) pending = pending.subarray(off);
  }

  let off = 0;
  while (off < pending.length) {
    if (pending.length - off <= CHUNK.MIN) {
      yield pending.subarray(off);
      return;
    }
    const n = cut(pending, off);
    yield pending.subarray(off, off + n);
    off += n;
  }
}

/** Chunk a file from disk. */
export function chunkFile(path) {
  return chunkStream(createReadStream(path, { highWaterMark: 1024 * 1024 }));
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Streaming sha256 of a file. */
export async function sha256File(path) {
  const h = createHash('sha256');
  for await (const piece of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    h.update(piece);
  }
  return h.digest('hex');
}
