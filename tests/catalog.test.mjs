import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../packages/cas-core/src/server.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'catalog-'));
const catalog = { schema: 1, games: [{ appId: '1001', title: '星海回响', demo: false }] };

test('serving a catalog from the reference server', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'repo'), { recursive: true });
  const latest = join(dir, 'repo', 'apps', '1001', 'latest.json');
  mkdirSync(join(dir, 'repo', 'apps', '1001'), { recursive: true });
  writeFileSync(latest, JSON.stringify({ appId: '1001', buildId: 'b1' }));

  const s = await startServer({ repoDir: join(dir, 'repo'), port: 0, catalogFile: join(dir, 'catalog.json') });
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog));

  const res = await fetch(`${s.url}/v1/catalog`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schema, 1);
  assert.equal(body.games[0].title, '星海回响');
  assert.equal(res.headers.get('cache-control'), 'no-cache');

  const h = await fetch(`${s.url}/v1/health`);
  assert.equal((await h.json()).catalog, true);

  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('no catalog configured -> documented 404 instead of silence', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'repo'), { recursive: true });
  const s = await startServer({ repoDir: join(dir, 'repo'), port: 0 });
  const res = await fetch(`${s.url}/v1/catalog`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /no catalog configured/);
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});
