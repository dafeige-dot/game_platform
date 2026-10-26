/**
 * Manifest format + deterministic serialization.
 *
 * The signature covers the exact bytes written to disk, so the client verifies
 * the raw bytes before parsing. That removes any need for JSON canonicalization
 * (a classic source of signature bugs between languages).
 */

export const SCHEMA = 1;

export const PLATFORMS = [
  'windows-x86_64',
  'windows-arm64',
  'macos-arm64',
  'macos-x86_64',
  'linux-x86_64',
  'android-arm64-v8a',
  'android-x86_64',
];

/** JSON.stringify with recursively sorted object keys. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function manifestBytes(manifest) {
  return Buffer.from(stableStringify(manifest), 'utf8');
}

/**
 * @typedef {Object} ChunkMeta
 * @property {number} size  plaintext bytes
 * @property {number} wire  bytes on the wire
 * @property {'zstd'|'raw'} enc
 */

/**
 * @typedef {Object} Manifest
 * @property {number} schema
 * @property {string} appId
 * @property {string} buildId
 * @property {string} platform
 * @property {string} version
 * @property {string} keyId
 * @property {string} createdAt
 * @property {number} totalSize
 * @property {number} wireSize
 * @property {string|null} entrypoint
 * @property {{path:string,size:number,sha256:string,chunks:string[]}[]} files
 * @property {Record<string, ChunkMeta>} chunks
 */

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-\u4e00-\u9fa5 /]+$/;

export function assertSafePath(p) {
  if (typeof p !== 'string' || !p || p.length > 512) throw new Error(`invalid path: ${p}`);
  if (p.includes('\\') || p.includes('\0')) throw new Error(`invalid path: ${p}`);
  if (!SAFE_PATH.test(p)) throw new Error(`unsafe path: ${p}`);
}

/** Structural validation. Cheap, run before trusting any manifest. */
export function validateManifest(m) {
  const fail = (msg) => {
    throw new Error(`invalid manifest: ${msg}`);
  };
  if (!m || typeof m !== 'object') fail('not an object');
  if (m.schema !== SCHEMA) fail(`unsupported schema ${m.schema}`);
  for (const k of ['appId', 'buildId', 'platform', 'version', 'keyId']) {
    if (typeof m[k] !== 'string' || !m[k]) fail(`missing ${k}`);
  }
  if (!PLATFORMS.includes(m.platform)) fail(`unknown platform ${m.platform}`);
  if (!Array.isArray(m.files)) fail('files');
  if (!m.chunks || typeof m.chunks !== 'object') fail('chunks');

  const seen = new Set();
  let total = 0;
  for (const f of m.files) {
    assertSafePath(f.path);
    if (seen.has(f.path)) fail(`duplicate path ${f.path}`);
    seen.add(f.path);
    if (!/^[a-f0-9]{64}$/.test(f.sha256)) fail(`bad file hash ${f.path}`);
    if (!Array.isArray(f.chunks)) fail(`bad chunks ${f.path}`);
    if (f.chunks.length === 0 && f.size > 0) fail(`empty chunk list ${f.path}`);
    total += f.size;
    for (const id of f.chunks) {
      const meta = m.chunks[id];
      if (!meta) fail(`missing chunk ${id}`);
      if (!/^[a-f0-9]{64}$/.test(id)) fail(`bad chunk id ${id}`);
      if (!['zstd', 'raw'].includes(meta.enc)) fail(`bad enc ${id}`);
    }
  }
  if (m.totalSize !== total) fail(`totalSize ${m.totalSize} != ${total}`);
  return m;
}
