/**
 * Client install / update orchestration.
 *
 * install and update are the same code path: the manifest is diffed against the
 * local chunk store, so an update is simply "the chunks I don't have yet".
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { sha256, sha256File } from './chunker.js';
import { downloadChunks, reqSignal } from './downloader.js';
import { manifestBytes, validateManifest } from './manifest.js';

const INSTALL_META = '.cas/install.json';

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal: reqSignal(signal) });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url, signal) {
  const res = await fetch(url, { signal: reqSignal(signal) });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return (await res.text()).trim();
}

async function fetchManifest({ serverBase, appId, buildId, signal }) {
  const base = serverBase.replace(/\/+$/, '');
  let id = buildId;
  if (id === 'latest') {
    const pointer = JSON.parse(
      (await withRetry(() => fetchJson(`${base}/apps/${appId}/latest.json`, signal), signal, 'latest pointer')).toString('utf8'),
    );
    id = pointer.buildId;
  }
  const url = `${base}/apps/${appId}/builds/${id}/manifest.json`;
  const bytes = await withRetry(() => fetchJson(url, signal), signal, 'manifest');
  const sig = await withRetry(() => fetchText(`${url}.sig`, signal), signal, 'manifest signature');
  return { buildId: id, bytes, sig };
}

/** Retry transient CDN failures. Manifests are small, so this is cheap. */
async function withRetry(fn, signal, label, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted || i + 1 >= attempts) {
        throw new Error(`${label} failed after ${i + 1} attempts: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(2000, 120 * 2 ** i) + Math.random() * 100));
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.buildId      build id or 'latest'
 * @param {string} opts.serverBase
 * @param {string} opts.dest         install root
 * @param {import('./store.js').CasStore} opts.store
 * @param {ReturnType<import('./sign.js').createTrustStore>} opts.trust
 */
export async function installBuild({
  appId,
  buildId = 'latest',
  serverBase,
  dest,
  store,
  trust,
  concurrency = 8,
  assumeYes = true,
  force = false,
  signal,
  onProgress = () => {},
  log = () => {},
}) {
  const started = Date.now();

  const { buildId: resolved, bytes, sig } = await fetchManifest({ serverBase, appId, buildId, signal });

  // Signature covers the exact bytes. Verify before parsing: nothing in the
  // payload is trusted until the signature checks out.
  const signerKeyId = trust.verifyAny(bytes, sig);
  if (!signerKeyId) throw new Error('manifest signature verification FAILED');
  log(`manifest signature ok (key ${signerKeyId.slice(0, 12)}…)`);

  const manifest = validateManifest(JSON.parse(bytes.toString('utf8')));
  if (manifest.appId !== appId) throw new Error(`appId mismatch: ${manifest.appId}`);
  if (manifest.keyId !== signerKeyId) throw new Error('signer key id mismatch');
  if (!assumeYes) throw new Error('interactive confirmation not supported in CLI spike');

  const allIds = new Set();
  for (const f of manifest.files) for (const id of f.chunks) allIds.add(id);

  const needed = [];
  let reusedBytes = 0;
  for (const id of allIds) {
    if (store.has(id)) reusedBytes += manifest.chunks[id].size;
    else needed.push(id);
  }
  const neededBytes = needed.reduce((n, id) => n + manifest.chunks[id].size, 0);

  log(
    `app ${manifest.appId} v${manifest.version} (${manifest.buildId}, ${manifest.platform})`,
  );
  log(
    `total ${fmt(manifest.totalSize)} · chunks ${allIds.size} · ` +
      `reuse ${allIds.size - needed.length} (${fmt(reusedBytes)}) · ` +
      `need ${needed.length} (${fmt(neededBytes)})`,
  );

  // Same build already installed and intact -> nothing to do.
  // `force` re-materializes from the local chunk store (repair, 0 bytes).
  const current = store.install(appId);
  if (
    !force &&
    current &&
    current.buildId === manifest.buildId &&
    current.root === dest &&
    filesLookIntact(dest, manifest)
  ) {
    log('already up to date');
    return { upToDate: true, manifest, stats: { downloaded: 0, wireBytes: 0, files: 0 } };
  }

  let dl = { downloaded: 0, wireBytes: 0, requests: 0, retries: 0 };
  if (needed.length) {
    dl = await downloadChunks({
      ids: needed,
      baseUrl: serverBase,
      store,
      chunks: manifest.chunks,
      concurrency,
      signal,
      onProgress: ({ done, total, wireBytes }) => onProgress({ phase: 'download', done, total, wireBytes }),
    });
  }

  onProgress({ phase: 'materialize', done: 0, total: manifest.files.length });
  const written = await materialize({ dest, manifest, store, onProgress });

  store.beginInstall(appId);
  for (const f of manifest.files) store.recordFile(appId, f);
  const manifestSha = sha256(bytes);
  store.commitInstall({ appId, buildId: manifest.buildId, root: dest, manifestSha });

  mkdirSync(join(dest, '.cas'), { recursive: true });
  writeFileSync(
    join(dest, INSTALL_META),
    JSON.stringify(
      {
        appId: manifest.appId,
        buildId: manifest.buildId,
        version: manifest.version,
        platform: manifest.platform,
        manifestSha256: manifestSha,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  return {
    upToDate: false,
    manifest,
    stats: {
      files: written,
      chunksTotal: allIds.size,
      chunksDownloaded: needed.length,
      chunksReused: allIds.size - needed.length,
      plainBytes: manifest.totalSize,
      wireBytes: dl.wireBytes,
      savedBytes: manifest.totalSize - neededBytes,
      requests: dl.requests,
      retries: dl.retries,
      ms: Date.now() - started,
    },
  };
}

function filesLookIntact(dest, manifest) {
  for (const f of manifest.files) {
    const p = join(dest, f.path);
    if (!existsSync(p)) return false;
    try {
      if (statSync(p).size !== f.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Write files by concatenating chunks, verifying each file hash. */
export async function materialize({ dest, manifest, store, onProgress = () => {} }) {
  let n = 0;
  // Entry point goes last: a half-finished install must not be launchable.
  const ordered = manifest.entrypoint
    ? [...manifest.files].sort((a, b) => Number(a.path === manifest.entrypoint) - Number(b.path === manifest.entrypoint))
    : manifest.files;

  for (const f of ordered) {
    const target = join(dest, f.path);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.cas-part`;

    await pipeline(
      (async function* () {
        for (const id of f.chunks) yield store.readPlain(id);
      })(),
      createWriteStream(tmp),
    );

    const got = await sha256File(tmp);
    if (got !== f.sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`file hash mismatch: ${f.path} (${got} != ${f.sha256})`);
    }
    rmSync(target, { force: true });
    renameSync(tmp, target);
    n++;
    onProgress({ phase: 'materialize', done: n, total: manifest.files.length, file: f.path });
  }
  if (manifest.entrypoint) {
    const p = join(dest, manifest.entrypoint);
    if (!existsSync(p)) throw new Error(`entrypoint missing: ${manifest.entrypoint}`);
  }
  return n;
}

/** Re-hash every installed file and report drift. */
export async function verifyInstall({ dest, manifest }) {
  const bad = [];
  for (const f of manifest.files) {
    const p = join(dest, f.path);
    if (!existsSync(p)) {
      bad.push({ path: f.path, reason: 'missing' });
      continue;
    }
    const got = await sha256File(p);
    if (got !== f.sha256) bad.push({ path: f.path, reason: 'corrupt', got });
  }
  return { ok: bad.length === 0, checked: manifest.files.length, bad };
}

export function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
