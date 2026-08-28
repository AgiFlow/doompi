import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUNDLE_MANIFEST_VERSION,
  type BundleAsset,
  type BundleManifest,
  type SignedBundleManifest,
  canonicalManifest,
} from '../types/bundleManifest.ts';

const SIGNING_FILE = 'signing.json';
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
/** P-256 rather than Ed25519: universally available in WebCrypto, which Ed25519 is not yet. */
const CURVE = 'prime256v1';
const SIGN_ALGORITHM = 'sha256';
/** Files a browser never fetches, so hashing them would only slow a rebuild. */
const SKIPPED = new Set(['.map']);

export interface BundleSigner {
  /** Base64url SPKI for an independently trusted verifier to pin. */
  publicKey(): string;
  /** Hashes the asset tree and signs the result. Undefined when there is no bundle to sign. */
  sign(assetsDir: string): SignedBundleManifest | undefined;
}

interface StoredKey {
  privateKey: string;
  publicKey: string;
}

/**
 * Loads the hub's signing key, generating one on first run.
 *
 * Long-lived so an external verifier can pin it. Rotating the key invalidates
 * those pins, and losing the file has the same effect.
 */
function loadKey(stateDir: string, onNotice: (message: string) => void): StoredKey {
  const keyPath = path.join(stateDir, SIGNING_FILE);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as StoredKey).privateKey === 'string' &&
      typeof (parsed as StoredKey).publicKey === 'string'
    ) {
      return parsed as StoredKey;
    }
    onNotice(`the bundle signing key at ${keyPath} is unreadable; generating a new one, so existing pins must be updated`);
  } catch {
    // First run, which is the normal path and not worth a notice.
  }
  const pair = generateKeyPairSync('ec', {
    namedCurve: CURVE,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const stored: StoredKey = {
    privateKey: pair.privateKey,
    publicKey: Buffer.from(pair.publicKey).toString('base64url'),
  };
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: DIRECTORY_MODE });
    fs.writeFileSync(keyPath, `${JSON.stringify(stored, undefined, 2)}\n`, { mode: FILE_MODE });
  } catch (error) {
    onNotice(`the bundle signing key could not be saved: ${error instanceof Error ? error.message : String(error)}`);
  }
  return stored;
}

/** Every servable file under the asset root, as browser paths. */
function walk(root: string, current: string, into: BundleAsset[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return; // A directory that vanished mid-walk contributes nothing.
  }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, into);
      continue;
    }
    if (!entry.isFile() || SKIPPED.has(path.extname(entry.name))) continue;
    try {
      const bytes = fs.readFileSync(full);
      into.push({
        path: `/${path.relative(root, full).split(path.sep).join('/')}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } catch {
      // Unreadable file; leaving it out of the manifest means it will fail
      // verification, which is the right direction to be wrong in.
    }
  }
}

export function createBundleSigner(stateDir: string, onNotice: (message: string) => void = () => {}): BundleSigner {
  const key = loadKey(stateDir, onNotice);
  const privateKey = createPrivateKey(key.privateKey);
  /** Cached per asset directory: hashing a bundle is not free and it never changes under us mid-run. */
  const cache = new Map<string, SignedBundleManifest | undefined>();

  return {
    publicKey: () => key.publicKey,

    sign(assetsDir) {
      const cached = cache.get(assetsDir);
      if (cached !== undefined || cache.has(assetsDir)) return cached;
      const assets: BundleAsset[] = [];
      walk(assetsDir, assetsDir, assets);
      if (assets.length === 0) {
        cache.set(assetsDir, undefined);
        return undefined;
      }
      const manifest: BundleManifest = { version: BUNDLE_MANIFEST_VERSION, builtAt: Date.now(), assets };
      const signature = createSign(SIGN_ALGORITHM)
        .update(canonicalManifest(manifest))
        .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
        .toString('base64url');
      const signed: SignedBundleManifest = { manifest, signature, publicKey: key.publicKey };
      cache.set(assetsDir, signed);
      return signed;
    },
  };
}

/** Re-derives the public key from a stored private key, for a test that wants to verify. */
export function publicKeyOf(privateKeyPem: string): string {
  return Buffer.from(createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' }) as Buffer).toString(
    'base64url',
  );
}
