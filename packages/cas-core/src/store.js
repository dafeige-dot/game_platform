/**
 * Client-side content-addressed store.
 *
 * Chunks are stored decompressed-key (id = sha256 of plaintext) but kept on
 * disk in whatever encoding they arrived in, so redownloads never re-compress.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync, constants as zconstants } from 'node:zlib';

import { sha256 } from './chunker.js';

const ZSTD_LEVEL = 3;
const COMPRESS_GAIN = 0.97;

export class CasStore {
  constructor(root) {
    this.root = root;
    this.objects = join(root, 'objects');
    this.tmp = join(root, 'tmp');
    mkdirSync(this.objects, { recursive: true });
    mkdirSync(this.tmp, { recursive: true });
    this.db = new DatabaseSync(join(root, 'index.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
      CREATE INDEX IF NOT EXISTS idx_file_chunk_chunk ON file_chunk (chunk_id);
    `);
    this.#q = {
      chunk: this.db.prepare('SELECT id, size, wire, enc FROM chunk WHERE id = ?'),
      chunkIds: this.db.prepare('SELECT id FROM chunk'),
      insertChunk: this.db.prepare(
        'INSERT OR REPLACE INTO chunk (id, size, wire, enc) VALUES (?, ?, ?, ?)',
      ),
      insertFile: this.db.prepare(
        'INSERT OR REPLACE INTO file (app_id, path, sha256, size) VALUES (?, ?, ?, ?)',
      ),
      insertFileChunk: this.db.prepare(
        'INSERT OR REPLACE INTO file_chunk (app_id, path, ord, chunk_id) VALUES (?, ?, ?, ?)',
      ),
      delFiles: this.db.prepare('DELETE FROM file WHERE app_id = ?'),
      delFileChunks: this.db.prepare('DELETE FROM file_chunk WHERE app_id = ?'),
      upsertInstall: this.db.prepare(
        `INSERT OR REPLACE INTO install (app_id, build_id, root, manifest_sha, installed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      getInstall: this.db.prepare('SELECT * FROM install WHERE app_id = ?'),
      allInstalls: this.db.prepare('SELECT * FROM install ORDER BY installed_at DESC'),
      orphans: this.db.prepare(
        `SELECT id, size, enc FROM chunk
         WHERE id NOT IN (SELECT DISTINCT chunk_id FROM file_chunk)`,
      ),
    };
  }

  #q;

  pathFor(id, enc) {
    return join(this.objects, id.slice(0, 2), `${id}.${enc}`);
  }

  meta(id) {
    return this.#q.chunk.get(id) ?? null;
  }

  has(id) {
    const m = this.#q.chunk.get(id);
    return !!m && existsSync(this.pathFor(id, m.enc));
  }

  knownChunks() {
    const ids = new Set();
    for (const row of this.#q.chunkIds.all()) ids.add(row.id);
    return ids;
  }

  /** Decompressed chunk payload. */
  readPlain(id) {
    const m = this.#q.chunk.get(id);
    if (!m) throw new Error(`chunk not in store: ${id}`);
    const raw = readFileSync(this.pathFor(id, m.enc));
    return m.enc === 'zstd' ? zstdDecompressSync(raw) : raw;
  }

  writeObject(id, body, enc, plainSize) {
    const dest = this.pathFor(id, enc);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = join(this.tmp, `${id}.${randomBytes(6).toString('hex')}`);
    writeFileSync(tmp, body);
    renameSync(tmp, dest);
    this.#q.insertChunk.run(id, plainSize, body.length, enc);
  }

  /** Store a locally produced chunk (used by tests / offline install). */
  writePlain(id, buf) {
    const compressed = zstdCompressSync(buf, {
      params: { [zconstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
    });
    const useZstd = compressed.length < buf.length * COMPRESS_GAIN;
    this.writeObject(id, useZstd ? compressed : buf, useZstd ? 'zstd' : 'raw', buf.length);
  }

  /**
   * Accept bytes from the network. Verifies sha256 *after* decompression, so a
   * malicious CDN cannot inject content.
   */
  putFromWire(id, body, enc, expectedSize) {
    const plain = enc === 'zstd' ? zstdDecompressSync(body) : body;
    if (plain.length !== expectedSize) {
      throw new Error(`chunk ${id}: size ${plain.length} != ${expectedSize}`);
    }
    if (sha256(plain) !== id) throw new Error(`chunk ${id}: hash mismatch`);
    this.writeObject(id, body, enc, plain.length);
    return body.length;
  }

  /** Drop the previous plan for an app before recording a new one. */
  beginInstall(appId) {
    this.#q.delFiles.run(appId);
    this.#q.delFileChunks.run(appId);
  }

  recordFile(appId, file) {
    this.#q.insertFile.run(appId, file.path, file.sha256, file.size);
    for (const [ord, id] of file.chunks.entries()) {
      this.#q.insertFileChunk.run(appId, file.path, ord, id);
    }
  }

  commitInstall({ appId, buildId, root, manifestSha }) {
    this.#q.upsertInstall.run(appId, buildId, root, manifestSha, new Date().toISOString());
  }

  install(appId) {
    return this.#q.getInstall.get(appId) ?? null;
  }

  installs() {
    return this.#q.allInstalls.all();
  }

  /** Bytes held on disk (wire size). */
  usage() {
    let bytes = 0;
    let chunks = 0;
    for (const row of this.db.prepare('SELECT wire FROM chunk').all()) {
      bytes += row.wire;
      chunks++;
    }
    return { bytes, chunks };
  }

  /** Delete chunks referenced by no install. Returns reclaimed bytes. */
  gc() {
    const orphans = this.#q.orphans.all();
    let bytes = 0;
    for (const row of orphans) {
      const p = this.pathFor(row.id, row.enc);
      if (existsSync(p)) {
        bytes += statSync(p).size;
        rmSync(p, { force: true });
      }
    }
    this.db.exec(
      'DELETE FROM chunk WHERE id NOT IN (SELECT DISTINCT chunk_id FROM file_chunk)',
    );
    return { removed: orphans.length, bytes };
  }
}
