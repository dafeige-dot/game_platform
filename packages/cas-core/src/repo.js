/**
 * Server-side build repository: turns a directory into a signed manifest plus a
 * global content-addressed object store.
 *
 * Only *new* chunks are written, so packing v1.4 after v1.3 stores just the
 * delta. This is what makes "any version to any version" patching free.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { zstdCompressSync, constants as zconstants } from 'node:zlib';

import { chunkFile, sha256, sha256File } from './chunker.js';
import { assertSafePath, manifestBytes, SCHEMA } from './manifest.js';
import { keyIdOf, signBytes } from './sign.js';

const ZSTD_LEVEL = 3;
// Assets are often already compressed; don't pay CPU for ~0 gain.
const COMPRESS_GAIN = 0.97;

export const objectPath = (repoDir, id) => join(repoDir, 'objects', id.slice(0, 2), id);
export const manifestDir = (repoDir, appId, buildId) =>
  join(repoDir, 'apps', appId, 'builds', buildId);

async function walk(root, dir = root, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '.cas') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await walk(root, abs, out);
    else if (e.isFile()) out.push(relative(root, abs).split(sep).join('/'));
  }
  return out.sort();
}

/**
 * @param {object} opts
 * @param {string} opts.dir       build source directory
 * @param {string} opts.repoDir   content-addressed repository root
 * @param {string} opts.appId
 * @param {string} opts.buildId
 * @param {string} opts.version
 * @param {string} opts.platform
 * @param {string} opts.privateKeyPem
 * @param {string|null} [opts.entrypoint]
 */
export async function packBuild(opts) {
  const {
    dir,
    repoDir,
    appId,
    buildId,
    version,
    platform,
    privateKeyPem,
    entrypoint = null,
    onProgress = () => {},
  } = opts;

  if (!existsSync(dir)) throw new Error(`source dir not found: ${dir}`);

  const files = [];
  /** @type {Record<string, {size:number, wire:number, enc:'zstd'|'raw'}>} */
  const chunks = {};
  let totalSize = 0;
  let wireSize = 0;
  let newObjects = 0;
  let reusedObjects = 0;

  const paths = await walk(dir);
  for (const [i, rel] of paths.entries()) {
    assertSafePath(rel);
    const abs = join(dir, rel);
    const chunksForFile = [];
    const full = await sha256File(abs);

    for await (const buf of chunkFile(abs)) {
      const id = sha256(buf);
      chunksForFile.push(id);
      if (chunks[id]) {
        reusedObjects++;
        continue;
      }

      const compressed = zstdCompressSync(buf, {
        params: { [zconstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
      });
      const useZstd = compressed.length < buf.length * COMPRESS_GAIN;
      const body = useZstd ? compressed : buf;
      const enc = useZstd ? 'zstd' : 'raw';

      const dest = objectPath(repoDir, id);
      if (existsSync(dest)) {
        // Already in the repo from a previous build: zero work.
        reusedObjects++;
      } else {
        await mkdir(dirname(dest), { recursive: true });
        writeFileSync(dest, body);
        newObjects++;
      }
      chunks[id] = { size: buf.length, wire: body.length, enc };
      wireSize += body.length;
    }

    const size = statSync(abs).size;
    if (size !== chunksForFile.reduce((n, c) => n + chunks[c].size, 0)) {
      throw new Error(`chunking mismatch for ${rel}`);
    }
    totalSize += size;
    files.push({ path: rel, size, sha256: full, chunks: chunksForFile });
    onProgress({ file: rel, index: i + 1, total: paths.length });
  }

  /** @type {import('./manifest.js').Manifest} */
  const manifest = {
    schema: SCHEMA,
    appId,
    buildId,
    platform,
    version,
    keyId: keyIdOf(publicKeyFromPrivate(privateKeyPem)),
    createdAt: new Date().toISOString(),
    totalSize,
    wireSize,
    entrypoint,
    files,
    chunks,
  };

  const bytes = manifestBytes(manifest);
  const sig = signBytes(bytes, privateKeyPem);

  const out = manifestDir(repoDir, appId, buildId);
  await mkdir(out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), bytes);
  writeFileSync(join(out, 'manifest.json.sig'), sig);

  // "latest" pointer is one file; rollback = rewrite it (no rebuild).
  const versionsDir = join(repoDir, 'apps', appId);
  await mkdir(versionsDir, { recursive: true });
  writeFileSync(
    join(versionsDir, 'latest.json'),
    JSON.stringify({ appId, buildId, version, platform, keyId: manifest.keyId }),
  );

  return {
    manifest,
    manifestSha: sha256(bytes),
    stats: {
      files: files.length,
      totalSize,
      wireSize,
      chunks: Object.keys(chunks).length,
      newObjects,
      reusedObjects,
      manifestBytes: bytes.length,
    },
  };
}

/** Derive the public key PEM from a private key. */
function publicKeyFromPrivate(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

export async function listBuilds(repoDir, appId) {
  const dir = join(repoDir, 'apps', appId, 'builds');
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).sort();
}

export async function removeBuild(repoDir, appId, buildId) {
  await rm(manifestDir(repoDir, appId, buildId), { recursive: true, force: true });
}

export function readManifest(repoDir, appId, buildId) {
  const dir = manifestDir(repoDir, appId, buildId);
  const bytes = readFileSyncSafe(join(dir, 'manifest.json'));
  const sig = readFileSyncSafe(join(dir, 'manifest.json.sig')).toString('utf8');
  return { bytes, sig };
}

function readFileSyncSafe(p) {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p);
}

/** Rough on-disk accounting for capacity planning. */
export function repoStats(repoDir) {
  const root = join(repoDir, 'objects');
  let bytes = 0;
  let count = 0;
  if (!existsSync(root)) return { bytes, count };
  for (const a of readdirSync(root)) {
    for (const b of readdirSync(join(root, a))) {
      bytes += statSync(join(root, a, b)).size;
      count++;
    }
  }
  return { bytes, count };
}
