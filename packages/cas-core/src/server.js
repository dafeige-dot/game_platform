/**
 * Reference distribution server.
 *
 * Serves three things:
 *   /apps/:app/latest.json                          -> pointer (rollback = rewrite)
 *   /apps/:app/builds/:build/manifest.json[.sig]     -> signed manifest
 *   /objects/:id                                     -> content-addressed chunk
 *
 * In production this is replaced by object storage + CDN; the path layout is
 * identical, so the client does not change.
 */
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OBJ = /^\/objects\/([a-f0-9]{64})$/;
const MANIFEST = /^\/apps\/([A-Za-z0-9._-]+)\/builds\/([A-Za-z0-9._-]+)\/manifest\.json(\.sig)?$/;
const LATEST = /^\/apps\/([A-Za-z0-9._-]+)\/latest\.json$/;

const badSegment = (s) => s === '.' || s === '..' || s.includes('..');

export function startServer({
  repoDir,
  port = 0,
  host = '127.0.0.1',
  failRate = 0,
  failFirst = 0,
  latencyMs = 0,
  catalogFile = null,
}) {
  const counters = { requests: 0, bytes: 0, objectHits: 0, objectMisses: 0, errors: 0 };
  // Deterministic fault injection for tests: fail the first N object requests.
  let failBudget = failFirst;

  const send = (res, status, headers, body) => {
    res.writeHead(status, headers);
    if (body) {
      res.end(body);
      counters.bytes += body.length;
    } else {
      res.end();
    }
  };

  const server = createHttpServer(async (req, res) => {
    counters.requests++;
    if (latencyMs) await sleep(latencyMs);
    if (failRate > 0 && Math.random() < failRate) {
      counters.errors++;
      return send(res, 503, { 'content-type': 'text/plain' }, Buffer.from('injected failure'));
    }

    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    if (failBudget > 0 && path.startsWith('/objects/')) {
      failBudget--;
      counters.errors++;
      return send(res, 503, { 'content-type': 'text/plain' }, Buffer.from('injected failure'));
    }

    if (path === '/healthz') return send(res, 200, { 'content-type': 'text/plain' }, Buffer.from('ok'));
    if (path === '/stats') {
      return send(res, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(counters)));
    }

    let m = OBJ.exec(path);
    if (m) {
      const id = m[1];
      const dir = join(repoDir, 'objects', id.slice(0, 2));
      const candidates = [`${id}.zstd`, `${id}.raw`, id];
      const file = candidates.map((n) => join(dir, n)).find((p) => existsSync(p));
      if (!file) {
        counters.objectMisses++;
        return send(res, 404, { 'content-type': 'text/plain' }, Buffer.from('no such object'));
      }
      counters.objectHits++;
      const stat = statSync(file);
      const headers = {
        'content-type': 'application/octet-stream',
        'content-length': String(stat.size),
        etag: `"${id}"`,
        // Content-addressed: safe to cache forever, at every layer.
        'cache-control': 'public, max-age=31536000, immutable',
      };
      if (req.headers['if-none-match'] === `"${id}"`) return send(res, 304, headers, null);
      if (req.method === 'HEAD') return send(res, 200, headers, null);

      const body = readFileSync(file);
      res.writeHead(200, headers);
      res.end(body);
      counters.bytes += body.length;
      return;
    }

    m = MANIFEST.exec(path);
    if (m) {
      const [, appId, buildId, isSig] = m;
      if (badSegment(appId) || badSegment(buildId)) return send(res, 400, {}, null);
      const file = join(repoDir, 'apps', appId, 'builds', buildId, `manifest.json${isSig ?? ''}`);
      if (!existsSync(file)) {
        return send(res, 404, { 'content-type': 'text/plain' }, Buffer.from('no such manifest'));
      }
      const body = readFileSync(file);
      const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
      const headers = {
        'content-type': isSig ? 'text/plain' : 'application/json',
        'content-length': String(body.length),
        etag,
        // Manifests are mutable per build id in dev; never cache aggressively.
        'cache-control': 'no-cache',
      };
      if (req.headers['if-none-match'] === etag) return send(res, 304, headers, null);
      return send(res, 200, headers, body);
    }

    m = LATEST.exec(path);
    if (m) {
      const appId = m[1];
      if (badSegment(appId)) return send(res, 400, {}, null);
      const file = join(repoDir, 'apps', appId, 'latest.json');
      if (!existsSync(file)) return send(res, 404, {}, null);
      return send(res, 200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }, readFileSync(file));
    }

    if (path === '/v1/catalog') {
      // The catalog is authored upstream (运营后台 seed); served verbatim with
      // no-cache so clients refresh it on every boot.
      if (!catalogFile || !existsSync(catalogFile)) {
        return send(res, 404, { 'content-type': 'text/plain' }, Buffer.from('no catalog configured'));
      }
      return send(res, 200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }, readFileSync(catalogFile));
    }

    if (path === '/v1/health') {
      return send(res, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({
        ok: true, catalog: Boolean(catalogFile && existsSync(catalogFile)),
      })));
    }

    return send(res, 404, { 'content-type': 'text/plain' }, Buffer.from('not found'));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        url: `http://${host}:${actual}`,
        counters,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
