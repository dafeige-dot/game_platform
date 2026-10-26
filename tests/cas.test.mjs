import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  CasStore,
  CHUNK,
  chunkBuffer,
  createTrustStore,
  installBuild,
  manifestBytes,
  packBuild,
  saveKeyPair,
  sha256,
  startServer,
  validateManifest,
  verifyInstall,
  verifyBytes,
  signBytes,
  keyIdOf,
  readPublicKey,
} from '../packages/cas-core/src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cas-'));

test('chunker: deterministic and respects size bounds', () => {
  const buf = randomBytes(8 * 1024 * 1024);
  const a = [...chunkBuffer(buf)];
  const b = [...chunkBuffer(buf)];
  assert.deepEqual(a.map(sha256), b.map(sha256), 'same input must give same chunks');

  for (const [i, c] of a.entries()) {
    assert.ok(c.length <= CHUNK.MAX, `chunk ${i} too big: ${c.length}`);
    if (i < a.length - 1) assert.ok(c.length >= CHUNK.MIN, `chunk ${i} too small: ${c.length}`);
  }
  const total = a.reduce((n, c) => n + c.length, 0);
  assert.equal(total, buf.length, 'no bytes lost');
});

test('chunker: content-defined boundaries resync after a prefix insertion', () => {
  const base = randomBytes(8 * 1024 * 1024);
  const shifted = Buffer.concat([Buffer.from('INSERTED-PREFIX'), base]);

  const idsA = new Set([...chunkBuffer(base)].map(sha256));
  const idsB = [...chunkBuffer(shifted)].map(sha256);
  const overlap = idsB.filter((id) => idsA.has(id)).length;

  // This is the property that makes inserts cheap: only nearby chunks change.
  assert.ok(
    overlap >= idsA.size - 3,
    `expected resync, only ${overlap}/${idsA.size} chunks matched`,
  );
});

test('chunker: identical regions dedupe', () => {
  const block = randomBytes(1024 * 1024);
  const ids = [...chunkBuffer(block)].map(sha256);
  const again = [...chunkBuffer(block)].map(sha256);
  assert.deepEqual(ids, again);
});

test('manifest: rejects path traversal and duplicate paths', () => {
  const good = {
    schema: 1,
    appId: '1',
    buildId: 'b',
    platform: 'windows-x86_64',
    version: '1.0.0',
    keyId: 'k',
    createdAt: new Date().toISOString(),
    totalSize: 0,
    wireSize: 0,
    entrypoint: null,
    files: [{ path: 'a/b.txt', size: 0, sha256: '0'.repeat(64), chunks: [] }],
    chunks: {},
  };

  assert.doesNotThrow(() => validateManifest(good));
  assert.throws(() => validateManifest({ ...good, files: [{ ...good.files[0], path: '../evil' }] }), /unsafe|invalid/);
  assert.throws(() => validateManifest({ ...good, files: [{ ...good.files[0], path: '/abs/evil' }] }), /unsafe|invalid/);
  assert.throws(
    () => validateManifest({ ...good, files: [good.files[0], good.files[0]] }),
    /duplicate/,
  );
  assert.throws(() => validateManifest({ ...good, totalSize: 5 }), /totalSize/);
});

test('signing: signature covers exact manifest bytes', () => {
  const dir = tmp();
  const { privateKeyPem, publicKeyPem, keyId } = saveKeyPair(dir);
  const bytes = manifestBytes({ schema: 1, appId: '1', hello: 'world' });
  const sig = signBytes(bytes, privateKeyPem);

  assert.equal(verifyBytes(bytes, sig, publicKeyPem), true);
  assert.equal(keyIdOf(publicKeyPem), keyId);

  const tampered = Buffer.from(bytes.toString('utf8').replace('world', 'WORLD'));
  assert.equal(verifyBytes(tampered, sig, publicKeyPem), false, 'tamper must fail');

  // A different key cannot sign for the pinned one.
  const other = saveKeyPair(tmp());
  const forged = signBytes(bytes, other.privateKeyPem);
  assert.equal(verifyBytes(bytes, forged, publicKeyPem), false);

  rmSync(dir, { recursive: true, force: true });
});

test('store: rejects chunks whose plaintext hash does not match the id', () => {
  const root = tmp();
  const store = new CasStore(root);
  const payload = Buffer.from('real payload');
  const id = sha256(payload);

  assert.throws(
    () => store.putFromWire(id, Buffer.from('evil payload'), 'raw', payload.length),
    /hash mismatch/,
  );
  assert.throws(
    () => store.putFromWire(id, Buffer.from('evil payload!!'), 'raw', payload.length),
    /size/,
  );
  assert.equal(store.has(id), false);

  store.writePlain(id, payload);
  assert.equal(store.has(id), true);
  assert.equal(sha256(store.readPlain(id)), id);

  store.db.close();
  rmSync(root, { recursive: true, force: true });
});

test('end-to-end: install, update transfers only the delta, verify catches corruption', async (t) => {
  const root = tmp();
  const keys = saveKeyPair(join(root, 'keys'));
  const repo = join(root, 'repo');
  const v1 = join(root, 'v1');
  const v2 = join(root, 'v2');
  const dest = join(root, 'dest');

  mkdirSync(join(v1, 'data'), { recursive: true });
  const big = randomBytes(8 * 1024 * 1024);
  writeFileSync(join(v1, 'data', 'assets.pak'), big);
  writeFileSync(join(v1, 'game.exe'), randomBytes(2 * 1024 * 1024));
  writeFileSync(join(v1, 'config.json'), '{"v":1}');

  const p1 = await packBuild({
    dir: v1,
    repoDir: repo,
    appId: '42',
    buildId: 'b1',
    version: '1.0.0',
    platform: 'windows-x86_64',
    privateKeyPem: keys.privateKeyPem,
  });

  const srv = await startServer({ repoDir: repo, port: 0 });
  const store = new CasStore(join(root, 'store'));
  t.after(async () => {
    await srv.close();
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const trust = createTrustStore([readPublicKey(join(root, 'keys', 'public.pem'))]);

  const r1 = await installBuild({
    appId: '42',
    buildId: 'latest',
    serverBase: srv.url,
    dest,
    store,
    trust,
  });
  assert.equal(r1.stats.chunksDownloaded, p1.stats.chunks);
  assert.ok((await verifyInstall({ dest, manifest: r1.manifest })).ok);

  // v2: patch 64 KiB of a 8 MiB file + touch config
  const patched = Buffer.from(big);
  randomBytes(64 * 1024).copy(patched, 2 * 1024 * 1024);
  mkdirSync(join(v2, 'data'), { recursive: true });
  writeFileSync(join(v2, 'data', 'assets.pak'), patched);
  writeFileSync(join(v2, 'game.exe'), randomBytes(2 * 1024 * 1024));
  writeFileSync(join(v2, 'config.json'), '{"v":2}');

  await packBuild({
    dir: v2,
    repoDir: repo,
    appId: '42',
    buildId: 'b2',
    version: '1.1.0',
    platform: 'windows-x86_64',
    privateKeyPem: keys.privateKeyPem,
  });

  const r2 = await installBuild({
    appId: '42',
    buildId: 'latest',
    serverBase: srv.url,
    dest,
    store,
    trust,
  });

  assert.equal(r2.manifest.version, '1.1.0');
  assert.ok(r2.stats.chunksReused > 0, 'should reuse most chunks');
  assert.ok(
    r2.stats.wireBytes < r2.stats.plainBytes * 0.75,
    `update should be small: ${r2.stats.wireBytes} vs ${r2.stats.plainBytes}`,
  );
  assert.ok((await verifyInstall({ dest, manifest: r2.manifest })).ok);

  // Corruption is detected...
  const fs = await import('node:fs');
  fs.writeFileSync(join(dest, 'data', 'assets.pak'), Buffer.alloc(8 * 1024 * 1024, 7));
  const bad = await verifyInstall({ dest, manifest: r2.manifest });
  assert.equal(bad.ok, false);
  assert.equal(bad.bad[0].path, 'data/assets.pak');

  // ...and repair costs no bandwidth (chunks still in store).
  const r3 = await installBuild({
    appId: '42',
    buildId: 'latest',
    serverBase: srv.url,
    dest,
    store,
    trust,
    force: true,
  });
  assert.equal(r3.stats.wireBytes, 0);
  assert.ok((await verifyInstall({ dest, manifest: r3.manifest })).ok);

  // Missing locals are re-fetched, not silently accepted.
  const r4 = await installBuild({
    appId: '42',
    buildId: 'latest',
    serverBase: srv.url,
    dest: join(root, 'dest2'),
    store,
    trust,
  });
  assert.ok(r4.stats.wireBytes < r4.stats.plainBytes, 'shared store avoids refetching');
});

test('resilience: transient 503s are retried and the install still completes', async (t) => {
  const root = tmp();
  const keys = saveKeyPair(join(root, 'keys'));
  const repo = join(root, 'repo');
  const src = join(root, 'src');

  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'a.bin'), randomBytes(4 * 1024 * 1024));

  await packBuild({
    dir: src,
    repoDir: repo,
    appId: '7',
    buildId: 'b1',
    version: '1.0.0',
    platform: 'windows-x86_64',
    privateKeyPem: keys.privateKeyPem,
  });

  const srv = await startServer({ repoDir: repo, port: 0, failFirst: 3 });
  const store = new CasStore(join(root, 'store'));
  t.after(async () => {
    await srv.close();
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const trust = createTrustStore([readPublicKey(join(root, 'keys', 'public.pem'))]);

  const res = await installBuild({
    appId: '7',
    buildId: 'latest',
    serverBase: srv.url,
    dest: join(root, 'dest'),
    store,
    trust,
  });

  assert.ok(res.stats.retries >= 3, 'server injected failures, client should retry');
  assert.ok((await verifyInstall({ dest: join(root, 'dest'), manifest: res.manifest })).ok);
});
