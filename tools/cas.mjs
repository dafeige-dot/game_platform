#!/usr/bin/env node
/**
 * cas — reference CLI for the platform delivery protocol.
 *
 *   cas keygen                         generate signing keys
 *   cas pack <dir> --app --version     build a signed manifest + object store
 *   cas serve <repo> --port 8787       serve manifests/objects (CDN stand-in)
 *   cas install <app> --dest <dir>     install or update (same code path)
 *   cas verify <dest> --app --server   re-hash installed files
 *   cas gc --store <dir>               reclaim unreferenced chunks
 *   cas info <repo>                    repository stats
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CasStore,
  createTrustStore,
  fmt,
  installBuild,
  packBuild,
  repoStats,
  saveKeyPair,
  verifyInstall,
  listBuilds,
} from '../packages/cas-core/src/index.js';

const VALUE_KEYS = new Set([
  'app', 'version', 'platform', 'out', 'key', 'pub', 'dest', 'server', 'build',
  'store', 'port', 'entry', 'fail-rate', 'concurrency', 'dir', 'id', 'host', 'catalog',
]);

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const k = a.slice(2);
        if (VALUE_KEYS.has(k)) {
          const v = argv[i + 1];
          if (v === undefined || v.startsWith('--')) throw new Error(`--${k} needs a value`);
          flags[k] = v;
          i++;
        } else {
          flags[k] = true;
        }
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

const need = (v, name) => {
  if (!v) throw new Error(`missing --${name}`);
  return v;
};

const log = (...a) => console.log(...a);

function progressLine(label) {
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (now - last < 120 && p.done < p.total) return;
    last = now;
    const pct = ((p.done / p.total) * 100).toFixed(0).padStart(3);
    process.stdout.write(`\r  ${label} ${String(p.done).padStart(4)}/${p.total} ${pct}%`);
    if (p.done >= p.total) process.stdout.write('\n');
  };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = parseArgs(rest);

  switch (cmd) {
    case 'keygen': {
      const dir = f.out ?? '.keys';
      const res = saveKeyPair(dir, { force: !!f.force });
      log(`key id  ${res.keyId}`);
      log(`private ${join(dir, 'private.pem')}  (keep secret, never ship)`);
      log(`public  ${join(dir, 'public.pem')}   (pin inside the client)`);
      return;
    }

    case 'pack': {
      const dir = need(f._[0], 'dir');
      const repoDir = need(f.out, 'out');
      const privateKeyPem = readFileSync(need(f.key, 'key'), 'utf8');
      const buildId =
        f.build ?? `b_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
      log(
        `packing ${dir} -> ${repoDir} (app ${need(f.app, 'app')}, ${need(f.version, 'version')}, ${need(f.platform, 'platform')})`,
      );
      const { manifest, stats, manifestSha } = await packBuild({
        dir,
        repoDir,
        appId: f.app,
        version: f.version,
        platform: f.platform,
        buildId,
        privateKeyPem,
        entrypoint: f.entry ?? null,
        onProgress: progressLine('files'),
      });
      log(`  build      ${buildId}`);
      log(`  files      ${stats.files}`);
      log(`  size       ${fmt(stats.totalSize)} (wire ${fmt(stats.wireSize)})`);
      log(`  chunks     ${stats.chunks}  new ${stats.newObjects}  reused ${stats.reusedObjects}`);
      log(`  manifest   ${manifestSha.slice(0, 16)}…  ${stats.manifestBytes} B signed`);
      log(`  latest     -> ${buildId}`);
      return;
    }

    case 'serve': {
      const repoDir = need(f._[0], 'repo');
      const { startServer } = await import('../packages/cas-core/src/server.js');
      // default: a catalog.json sitting next to the repo (fixtures layout)
      const defaultCatalog = join(repoDir, '..', 'catalog.json');
      const catalogFile = f.catalog ?? (existsSync(defaultCatalog) ? defaultCatalog : null);
      const s = await startServer({
        repoDir,
        port: Number(f.port ?? 8787),
        host: f.host ?? '127.0.0.1',
        failRate: Number(f['fail-rate'] ?? 0),
        catalogFile,
      });
      log(`serving ${repoDir} on ${s.url}  (fail-rate ${f['fail-rate'] ?? 0}${catalogFile ? ', catalog ' + catalogFile : ''})`);
      log('ctrl-c to stop');
      process.on('SIGINT', async () => {
        await s.close();
        process.exit(0);
      });
      return;
    }

    case 'install': {
      const appId = need(f._[0], 'app');
      const store = new CasStore(f.store ?? '.cache/cas');
      const pubPath = f.pub ?? '.keys/public.pem';
      const trust = createTrustStore([readFileSync(pubPath, 'utf8')]);
      const res = await installBuild({
        appId,
        buildId: f.build ?? 'latest',
        serverBase: need(f.server, 'server'),
        dest: need(f.dest, 'dest'),
        store,
        trust,
        concurrency: Number(f.concurrency ?? 8),
        log,
        onProgress: progressLine('install'),
      });
      const st = res.stats;
      log('');
      log(`  version     ${res.manifest.version} (${res.manifest.buildId})`);
      if (res.upToDate) return log('  already up to date');
      log(`  downloaded  ${st.chunksDownloaded}/${st.chunksTotal} chunks, ${fmt(st.wireBytes)} wired`);
      log(`  file size   ${fmt(st.plainBytes)} total, ${fmt(st.savedBytes)} served from cache`);
      log(`  elapsed     ${(st.ms / 1000).toFixed(2)}s, retries ${st.retries}`);
      log(`  dest        ${f.dest}`);
      return;
    }

    case 'verify': {
      const dest = need(f._[0], 'dest');
      const appId = need(f.app, 'app');
      const trust = createTrustStore([readFileSync(f.pub ?? '.keys/public.pem', 'utf8')]);
      const base = need(f.server, 'server').replace(/\/+$/, '');
      const build = f.build ?? 'latest';
      let buildId = build;
      if (build === 'latest') {
        buildId = (await (await fetch(`${base}/apps/${appId}/latest.json`)).json()).buildId;
      }
      const url = `${base}/apps/${appId}/builds/${buildId}/manifest.json`;
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      const sig = (await (await fetch(`${url}.sig`)).text()).trim();
      if (!trust.verifyAny(bytes, sig)) throw new Error('signature verification failed');
      const manifest = JSON.parse(bytes.toString('utf8'));
      const res = await verifyInstall({ dest, manifest });
      log(res.ok ? `OK  ${res.checked} files intact` : `FAIL ${res.bad.length}/${res.checked} files damaged`);
      for (const b of res.bad) log(`  ${b.reason.padEnd(8)} ${b.path}`);
      if (!res.ok) process.exitCode = 1;
      return;
    }

    case 'gc': {
      const store = new CasStore(f.store ?? '.cache/cas');
      const { removed, bytes } = store.gc();
      log(`removed ${removed} chunks, reclaimed ${fmt(bytes)}`);
      return;
    }

    case 'info': {
      const repoDir = need(f._[0], 'repo');
      const s = repoStats(repoDir);
      const apps = existsSync(join(repoDir, 'apps')) ? readdirSync(join(repoDir, 'apps')) : [];
      log(`repo        ${repoDir}`);
      log(`objects     ${s.count} (${fmt(s.bytes)} on disk)`);
      log(`apps        ${apps.join(', ') || '-'}`);
      for (const a of apps) {
        const builds = await listBuilds(repoDir, a);
        const latest = existsSync(join(repoDir, 'apps', a, 'latest.json'))
          ? JSON.parse(readFileSync(join(repoDir, 'apps', a, 'latest.json'), 'utf8'))
          : null;
        const total = builds.reduce(
          (n, b) => n + statSync(join(repoDir, 'apps', a, 'builds', b)).size,
          0,
        );
        log(`  ${a}: ${builds.length} builds, latest ${latest?.buildId ?? '-'}`);
      }
      return;
    }

    default:
      log(readFileSync(new URL('./cas.usage.txt', import.meta.url), 'utf8'));
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
