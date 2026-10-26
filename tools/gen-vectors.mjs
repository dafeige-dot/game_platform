#!/usr/bin/env node
/**
 * Regenerates fixtures for the Rust cross-validation tests:
 *   - deterministic PRNG datasets + chunk boundaries (from the Node reference)
 *   - one real signed manifest + CAS objects via packBuild
 *
 * Determinism: the same PRNG seed -> the same bytes -> the same cut points,
 * so the fixture set is stable across runs (only createdAt/sig change, and the
 * tests verify the *stored* signature, not a hardcoded hash).
 *
 * npm run vectors
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { chunkBuffer, sha256 } from '../packages/cas-core/src/chunker.js';
import { packBuild } from '../packages/cas-core/src/repo.js';
import { saveKeyPair, keyIdOf } from '../packages/cas-core/src/sign.js';
import { GEAR_SEED, CHUNK } from '../packages/cas-core/src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'packages', 'cas-core-rs', 'tests', 'fixtures');
const KEYS = join(ROOT, '.keys');
const SRC = join(ROOT, 'demo', 'vectors-src');
const REPO = join(FIX, 'repo');

/** LCG, identical to the one the Rust test uses to rebuild the same bytes. */
function fill(seed, size) {
  let x = seed >>> 0 || 1;
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = (x >>> 24) & 0xff;
  }
  return buf;
}

function boundaries(buf) {
  const out = [];
  let off = 0;
  for (const c of chunkBuffer(buf)) {
    out.push([off, c.length]);
    off += c.length;
  }
  if (off !== buf.length) throw new Error('boundary math lost bytes');
  return out;
}

async function main() {
  // 1. signing keys (create once, reuse forever — trust root stability)
  if (!existsSync(join(KEYS, 'public.pem'))) {
    saveKeyPair(KEYS);
    console.log(`generated new keys in ${KEYS}`);
  }
  const pubPem = readFileSync(join(KEYS, 'public.pem'), 'utf8');
  const spki = createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
  const pubRawHex = spki.subarray(spki.length - 32).toString('hex');
  const keyId = keyIdOf(pubPem);

  // 2. datasets
  // `parts` makes reconstruction table-driven in the Rust test:
  // byte  N*seed*N of the body is simply the PRNG streams concatenated.
  const mk = (name, parts, note) => {
    const buf = Buffer.concat(parts.map(([seed, size]) => fill(seed, size)));
    return {
      name,
      parts,
      size: buf.length,
      sha256: sha256(buf),
      chunks: boundaries(buf),
      note,
    };
  };

  const datasets = [
    // below MIN: single chunk
    mk('random-sma11', [[4711, 262_000]]),
    mk('random-3m', [[7, 3 * 1024 * 1024 + 777]]),
    mk('random-8k-pages', [[20261026, 8 * 1024 * 1024]]),
    // prefix insertion: boundaries must resync (the property that makes
    // patched installs cheap); the Rust test asserts the property itself.
    mk(
      'prefix-4k-shift',
      [[99, 4000], [20261026, 8 * 1024 * 1024]],
      'random-8k-pages body behind a 4000 B prefix (seed 99)',
    ),
  ];

  // 3. real repo: a signed manifest via the *actual* packer
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(join(SRC, 'bin'), { recursive: true });
  mkdirSync(join(SRC, 'data', 'locale'), { recursive: true });
  writeFileSync(join(SRC, 'bin', 'game.exe'), fill(1001, 2 * 1024 * 1024 + 256 * 1024));
  writeFileSync(join(SRC, 'data', 'assets.pak'), fill(1002, 6 * 1024 * 1024));
  writeFileSync(join(SRC, 'data', 'locale', 'zh_cn.bin'), Buffer.from('星海回响 · 星图版本校验样文。'.repeat(2048)));
  writeFileSync(join(SRC, 'config.json'), Buffer.from('{"vectors":1}'));

  const { manifest, stats } = await packBuild({
    dir: SRC,
    repoDir: REPO,
    appId: '1001',
    buildId: 'v1.0.0-b1',
    version: '1.0.0',
    platform: 'windows-x86_64',
    privateKeyPem: readFileSync(join(KEYS, 'private.pem'), 'utf8'),
    entrypoint: 'bin/game.exe',
  });

  // 4. write everything
  mkdirSync(FIX, { recursive: true });
  const vectors = {
    format: 1,
    generator: 'tools/gen-vectors.mjs',
    note: 'PRNG: x = (x*1664525+1013904223)>>>0; byte = x>>>24',
    gear: { seed: GEAR_SEED, min: CHUNK.MIN, normal: CHUNK.NORMAL, max: CHUNK.MAX, maskS: CHUNK.MASK_S, maskL: CHUNK.MASK_L },
    pubRawHex,
    keyId,
    datasets,
    manifest: {
      appId: manifest.appId,
      buildId: manifest.buildId,
      version: manifest.version,
      platform: manifest.platform,
      totalSize: manifest.totalSize,
      wireSize: manifest.wireSize,
      entries: manifest.files.map((f) => f.path),
      chunkCount: Object.keys(manifest.chunks).length,
    },
  };
  writeFileSync(join(FIX, 'vectors.json'), JSON.stringify(vectors, null, 2));

  console.log(`pack stats: ${stats.files} files, ${stats.chunks} chunks, repo ${REPO}`);
  console.log(`fixtures ok -> ${FIX}`);
  console.log(`keyId: ${keyId}`);
}

function saveKeys() {
  // node:crypto can't seed ed25519; we persist whatever pair we generate so
  // regenerations only refresh signatures, not trust roots.
  const { saveKeyPair } = require('../packages/cas-core/src/sign.js');
  saveKeyPair(KEYS);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
