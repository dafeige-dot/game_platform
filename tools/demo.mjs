#!/usr/bin/env node
/**
 * End-to-end demo of the delivery protocol:
 *   pack v1 -> install -> change 1 asset + add DLC -> pack v2 -> update
 * and report how much bandwidth the update actually cost.
 */
import { cpSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
  CasStore,
  createTrustStore,
  fmt,
  installBuild,
  packBuild,
  readPublicKey,
  repoStats,
  saveKeyPair,
  startServer,
  verifyInstall,
} from '../packages/cas-core/src/index.js';

const ROOT = join(import.meta.dirname, '..', 'demo', 'tmp');
const KEYS = join(ROOT, 'keys');
const REPO = join(ROOT, 'repo');
const SRC1 = join(ROOT, 'src-v1');
const SRC2 = join(ROOT, 'src-v2');
const STORE = join(ROOT, 'store');
const DEST = join(ROOT, 'install');
const APP = '1001';

const line = (c = '─') => console.log(c.repeat(64));
const step = (t) => {
  line();
  console.log(`▶ ${t}`);
  line();
};

function write(rel, bytes) {
  const p = join(SRC1, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSyncSafe(p, bytes);
}

function writeFileSyncSafe(p, bytes) {
  const fd = openSync(p, 'w');
  writeSync(fd, bytes);
  closeSync(fd);
}

function patchAt(path, offset, bytes) {
  const fd = openSync(path, 'r+');
  writeSync(fd, bytes, 0, bytes.length, offset);
  closeSync(fd);
}

function sizeOf(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n += statSync(p).size;
    }
  };
  walk(dir);
  return n;
}

async function main() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  step('keygen (Ed25519, pinned in client)');
  const keys = saveKeyPair(KEYS);
  console.log(`key id: ${keys.keyId}`);

  step('build v1.0.0');
  write('bin/game.exe', randomBytes(12 * 1024 * 1024));
  write('data/assets.pak', randomBytes(24 * 1024 * 1024));
  write('data/locale/zh_cn.bin', randomBytes(2 * 1024 * 1024));
  write('config.json', Buffer.from(JSON.stringify({ version: '1.0.0', render: 'high' }, null, 2)));
  const v1Size = sizeOf(SRC1);
  console.log(`source size: ${fmt(v1Size)}`);

  const pack1 = await packBuild({
    dir: SRC1,
    repoDir: REPO,
    appId: APP,
    buildId: 'v1.0.0-b1',
    version: '1.0.0',
    platform: 'windows-x86_64',
    privateKeyPem: readFileSync(join(KEYS, 'private.pem'), 'utf8'),
    entrypoint: 'bin/game.exe',
  });
  console.log(
    `packed: ${pack1.stats.files} files, ${pack1.stats.chunks} chunks, ` +
      `new objects ${pack1.stats.newObjects}, wire ${fmt(pack1.stats.wireSize)}`,
  );

  const srv = await startServer({ repoDir: REPO, port: 0 });
  console.log(`server: ${srv.url}`);

  const trust = createTrustStore([readPublicKey(join(KEYS, 'public.pem'))]);
  const store = new CasStore(STORE);

  step('fresh install (v1.0.0)');
  const t1 = Date.now();
  const r1 = await installBuild({
    appId: APP,
    buildId: 'latest',
    serverBase: srv.url,
    dest: DEST,
    store,
    trust,
    concurrency: 8,
  });
  console.log(
    `installed in ${((Date.now() - t1) / 1000).toFixed(2)}s · ` +
      `download ${fmt(r1.stats.wireBytes)} / ${fmt(r1.stats.plainBytes)} ` +
      `(${r1.stats.chunksDownloaded} chunks, ${r1.stats.retries} retries)`,
  );
  console.log(`on disk: ${fmt(sizeOf(DEST))}`);

  step('build v1.1.0 (patched 256 KiB asset + new DLC pack + config change)');
  cpSync(SRC1, SRC2, { recursive: true });
  // 256 KiB overwrite inside a 12 MiB file -> only the chunks covering it change
  patchAt(join(SRC2, 'bin/game.exe'), 3 * 1024 * 1024, randomBytes(256 * 1024));
  writeFileSyncSafe(
    join(SRC2, 'config.json'),
    Buffer.from(JSON.stringify({ version: '1.1.0', render: 'ultra' }, null, 2)),
  );
  writeFileSyncSafe(join(SRC2, 'data/dlc.pak'), randomBytes(8 * 1024 * 1024));

  const v2Size = sizeOf(SRC2);
  const pack2 = await packBuild({
    dir: SRC2,
    repoDir: REPO,
    appId: APP,
    buildId: 'v1.1.0-b2',
    version: '1.1.0',
    platform: 'windows-x86_64',
    privateKeyPem: readFileSync(join(KEYS, 'private.pem'), 'utf8'),
    entrypoint: 'bin/game.exe',
  });
  console.log(
    `packed: ${pack2.stats.files} files, ${pack2.stats.chunks} chunks, ` +
      `new objects ${pack2.stats.newObjects} (repo reused ${pack2.stats.reusedObjects})`,
  );

  step('update v1.0.0 -> v1.1.0');
  const t2 = Date.now();
  const r2 = await installBuild({
    appId: APP,
    buildId: 'latest',
    serverBase: srv.url,
    dest: DEST,
    store,
    trust,
    concurrency: 8,
  });
  const secs = ((Date.now() - t2) / 1000).toFixed(2);
  console.log(
    `updated in ${secs}s · download ${fmt(r2.stats.wireBytes)} instead of ${fmt(r2.stats.plainBytes)}`,
  );
  console.log(
    `chunks: ${r2.stats.chunksReused} reused, ${r2.stats.chunksDownloaded} downloaded ` +
      `(${r2.stats.retries} retries)`,
  );

  step('verify installed files');
  const v = await verifyInstall({ dest: DEST, manifest: r2.manifest });
  console.log(v.ok ? `OK · ${v.checked} files intact` : `FAIL · ${v.bad.length} damaged`);

  step('tamper detection');
  patchAt(join(DEST, 'data/assets.pak'), 1024 * 1024, Buffer.from('HACKED'));
  const t = await verifyInstall({ dest: DEST, manifest: r2.manifest });
  console.log(`corrupted 1 file -> verify ${t.ok ? 'MISSED (bug)' : 'caught it'}: ${t.bad[0]?.path}`);

  step('repair by re-running install (files rebuilt from the local chunk store)');
  const t3 = Date.now();
  const r3 = await installBuild({
    appId: APP,
    buildId: 'latest',
    serverBase: srv.url,
    dest: DEST,
    store,
    trust,
    force: true,
  });
  console.log(`repaired in ${((Date.now() - t3) / 1000).toFixed(2)}s, downloaded ${fmt(r3.stats.wireBytes)}`);
  const v2 = await verifyInstall({ dest: DEST, manifest: r3.manifest });
  console.log(v2.ok ? `OK · ${v2.checked} files intact` : `FAIL`);

  step('storage');
  const rs = repoStats(REPO);
  console.log(`server objects: ${rs.count} chunks, ${fmt(rs.bytes)} on disk`);
  const usage = store.usage();
  console.log(`client store:   ${usage.chunks} chunks, ${fmt(usage.bytes)} (shared across installs)`);

  step('summary');
  console.log(`v1 source      ${fmt(v1Size)}`);
  console.log(`v2 source      ${fmt(v2Size)}  (+${fmt(v2Size - v1Size)})`);
  console.log(`update on wire ${fmt(r2.stats.wireBytes)}`);
  console.log(
    `saved          ${fmt(Math.max(0, v2Size - r2.stats.wireBytes))} ` +
      `(${(100 * (1 - r2.stats.wireBytes / v2Size)).toFixed(1)}% vs full download)`,
  );

  await srv.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
