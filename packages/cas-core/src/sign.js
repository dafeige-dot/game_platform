/**
 * Manifest signing (Ed25519).
 *
 * The public key is pinned inside the client binary / config. The manifest is
 * the only trust root for what files land on disk, so this is the single most
 * important security boundary in the platform.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function keyIdOf(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}

/** Write `<dir>/private.pem` and `<dir>/public.pem`, refusing to overwrite. */
export function saveKeyPair(dir, { force = false } = {}) {
  const priv = join(dir, 'private.pem');
  const pub = join(dir, 'public.pem');
  if (!force && (existsSync(priv) || existsSync(pub))) {
    throw new Error(`keys already exist in ${dir} (use --force)`);
  }
  const pair = generateKeyPair();
  mkdirSync(dir, { recursive: true });
  writeFileSync(priv, pair.privateKeyPem, { mode: 0o600 });
  writeFileSync(pub, pair.publicKeyPem);
  return { ...pair, keyId: keyIdOf(pair.publicKeyPem), dir };
}

export const readPublicKey = (p) => readFileSync(p, 'utf8');
export const readPrivateKey = (p) => readFileSync(p, 'utf8');

export function signBytes(bytes, privateKeyPem) {
  return sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64');
}

export function verifyBytes(bytes, signatureB64, publicKeyPem) {
  try {
    return verify(
      null,
      bytes,
      createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Pinned-key store. A real client ships this compiled in; the CLI uses a file
 * so we can rotate keys during development.
 */
export function createTrustStore(pems) {
  const keys = new Map();
  for (const pem of pems) keys.set(keyIdOf(pem), pem);
  return {
    keys,
    has: (id) => keys.has(id),
    /** Verify that `bytes` were signed by the key with ID `keyId`. */
    verify(bytes, signatureB64, keyId) {
      const pem = keys.get(keyId);
      if (!pem) return false;
      return verifyBytes(bytes, signatureB64, pem);
    },
    /**
     * Try every pinned key. Safer than reading keyId from the (untrusted)
     * manifest first.
     */
    verifyAny(bytes, signatureB64) {
      for (const [id, pem] of keys) {
        if (verifyBytes(bytes, signatureB64, pem)) return id;
      }
      return null;
    },
  };
}
