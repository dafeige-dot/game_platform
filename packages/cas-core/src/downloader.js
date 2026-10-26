/**
 * Concurrent chunk downloader with per-chunk retry.
 *
 * Resume is inherent: completed chunks live in the store, so re-running after a
 * crash/network drop only fetches what is still missing.
 */
export async function downloadChunks({
  ids,
  baseUrl,
  store,
  chunks,
  concurrency = 8,
  retries = 4,
  signal,
  onProgress = () => {},
}) {
  const base = baseUrl.replace(/\/+$/, '');
  const stats = { requested: ids.length, downloaded: 0, wireBytes: 0, requests: 0, retries: 0 };

  if (ids.length === 0) return stats;

  let cursor = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted');
      const i = cursor++;
      if (i >= ids.length) return;
      const id = ids[i];
      const meta = chunks[id];
      if (!meta) throw new Error(`no metadata for chunk ${id}`);

      let attempt = 0;
      for (;;) {
        try {
          stats.requests++;
          const res = await fetch(`${base}/objects/${id}`, { signal: reqSignal(signal) });
          if (!res.ok) {
            // Drain the body: an unconsumed error response keeps the
            // connection checked out and can deadlock shutdown.
            await res.arrayBuffer().catch(() => {});
            throw new Error(`HTTP ${res.status}`);
          }
          const body = Buffer.from(await res.arrayBuffer());
          const wire = store.putFromWire(id, body, meta.enc, meta.size);
          stats.downloaded++;
          stats.wireBytes += wire;
          break;
        } catch (err) {
          if (signal?.aborted) throw err;
          attempt++;
          if (attempt > retries) {
            throw new Error(`chunk ${id} failed after ${retries + 1} attempts: ${err.message}`);
          }
          stats.retries++;
          const backoff = Math.min(2000, 100 * 2 ** attempt) + Math.random() * 100;
          await sleep(backoff, signal);
        }
      }

      done++;
      onProgress({ done, total: ids.length, wireBytes: stats.wireBytes, id });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return stats;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/** Per-request timeout, combined with the caller's abort signal. */
export function reqSignal(signal, ms = 30_000) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
