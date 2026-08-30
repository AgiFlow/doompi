import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUNDLE_MANIFEST_VERSION,
  type BundleAsset,
  type BundleManifest,
  type SignedBundleManifest,
  canonicalManifest,
  isBundleManifest,
} from '../types/bundleManifest.ts';

const SIGNING_FILE = 'signing.json';
const LOCK_FILE = 'signing.lock';
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const CURVE = 'prime256v1';
const SIGN_ALGORITHM = 'sha256';
const SKIPPED = new Set(['.map']);
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface BundleSigner {
  /** Base64url SPKI for an independently trusted verifier to pin. */
  publicKey(): string;
  /** Hashes and signs once per asset directory. Undefined when the bundle is empty. */
  sign(assetsDir: string): SignedBundleManifest | undefined;
  /** Invalidates and immediately rebuilds one cached manifest. */
  refresh(assetsDir: string): SignedBundleManifest | undefined;
  /** Invalidates one cached directory, or every cached directory when omitted. */
  invalidate(assetsDir?: string): void;
}

interface StoredState {
  privateKey: string;
  publicKey: string;
  revision: number;
}

function ensureStateDirectory(stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: DIRECTORY_MODE });
  const stat = fs.lstatSync(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`bundle signing state is not a directory: ${stateDir}`);
  fs.chmodSync(stateDir, DIRECTORY_MODE);
}

function withStateLock<T>(stateDir: string, operation: () => T): T {
  ensureStateDirectory(stateDir);
  const lockPath = path.join(stateDir, LOCK_FILE);
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      descriptor = fs.openSync(lockPath, 'wx', FILE_MODE);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (descriptor === undefined) throw new Error(`timed out waiting for bundle signing state lock: ${lockPath}`);
  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  }
}

function atomicWriteState(stateDir: string, state: StoredState): void {
  const destination = path.join(stateDir, SIGNING_FILE);
  const temporary = path.join(stateDir, `.${SIGNING_FILE}.${process.pid}.${randomBytes(8).toString('hex')}`);
  const descriptor = fs.openSync(temporary, 'wx', FILE_MODE);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(state, undefined, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, FILE_MODE);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function parseState(value: unknown, keyPath: string): StoredState {
  if (typeof value !== 'object' || value === null) throw new Error(`invalid bundle signing state: ${keyPath}`);
  const candidate = value as Partial<StoredState>;
  if (typeof candidate.privateKey !== 'string' || typeof candidate.publicKey !== 'string') {
    throw new Error(`invalid bundle signing state: ${keyPath}`);
  }
  const revision = candidate.revision === undefined ? 0 : candidate.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error(`invalid bundle signing revision: ${keyPath}`);
  let derived: string;
  try {
    derived = publicKeyOf(candidate.privateKey);
  } catch {
    throw new Error(`invalid bundle signing private key: ${keyPath}`);
  }
  if (derived !== candidate.publicKey) throw new Error(`bundle signing keys do not match: ${keyPath}`);
  return { privateKey: candidate.privateKey, publicKey: candidate.publicKey, revision };
}

function loadOrCreateState(stateDir: string): StoredState {
  return withStateLock(stateDir, () => {
    const keyPath = path.join(stateDir, SIGNING_FILE);
    try {
      const stat = fs.lstatSync(keyPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid bundle signing state file: ${keyPath}`);
      const parsed: unknown = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      const state = parseState(parsed, keyPath);
      fs.chmodSync(keyPath, FILE_MODE);
      if ((parsed as Partial<StoredState>).revision === undefined) atomicWriteState(stateDir, state);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const pair = generateKeyPairSync('ec', {
      namedCurve: CURVE,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    const state: StoredState = {
      privateKey: pair.privateKey,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'),
      revision: 0,
    };
    atomicWriteState(stateDir, state);
    return state;
  });
}

function reserveRevision(stateDir: string, expectedPublicKey: string): number {
  return withStateLock(stateDir, () => {
    const keyPath = path.join(stateDir, SIGNING_FILE);
    const state = parseState(JSON.parse(fs.readFileSync(keyPath, 'utf8')) as unknown, keyPath);
    if (state.publicKey !== expectedPublicKey)
      throw new Error('bundle signing key changed while the signer was active');
    if (state.revision === Number.MAX_SAFE_INTEGER) throw new Error('bundle signing revision is exhausted');
    const next = { ...state, revision: state.revision + 1 };
    atomicWriteState(stateDir, next);
    return next.revision;
  });
}

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Every servable regular file under the asset root, as browser paths. */
function walk(root: string, current: string, into: BundleAsset[]): void {
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`refusing to sign symbolic link: ${full}`);
    if (stat.isDirectory()) {
      walk(root, full, into);
      continue;
    }
    if (!stat.isFile()) throw new Error(`refusing to omit unsupported asset: ${full}`);
    if (SKIPPED.has(path.extname(entry.name))) continue;
    const bytes = fs.readFileSync(full);
    into.push({
      path: `/${path
        .relative(root, full)
        .split(path.sep)
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
      contentType: contentTypeFor(full),
    });
  }
}

export function createBundleSigner(stateDir: string, _onNotice: (message: string) => void = () => {}): BundleSigner {
  const key = loadOrCreateState(stateDir);
  const privateKey = createPrivateKey(key.privateKey);
  const cache = new Map<string, SignedBundleManifest | undefined>();

  const signFresh = (assetsDir: string): SignedBundleManifest | undefined => {
    const rootStat = fs.lstatSync(assetsDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`refusing to sign an unsafe asset root: ${assetsDir}`);
    }
    const assets: BundleAsset[] = [];
    walk(assetsDir, assetsDir, assets);
    if (assets.length === 0) return undefined;
    assets.sort((left, right) => left.path.localeCompare(right.path));
    const manifest: BundleManifest = {
      version: BUNDLE_MANIFEST_VERSION,
      revision: reserveRevision(stateDir, key.publicKey),
      builtAt: Date.now(),
      assets,
    };
    if (!isBundleManifest(manifest)) throw new Error('refusing to sign an invalid bundle manifest');
    const signature = createSign(SIGN_ALGORITHM)
      .update(canonicalManifest(manifest))
      .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    return { manifest, signature, publicKey: key.publicKey };
  };

  const sign = (assetsDir: string): SignedBundleManifest | undefined => {
    const cacheKey = path.resolve(assetsDir);
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const signed = signFresh(cacheKey);
    cache.set(cacheKey, signed);
    return signed;
  };

  return {
    publicKey: () => key.publicKey,
    sign,
    refresh(assetsDir) {
      const cacheKey = path.resolve(assetsDir);
      cache.delete(cacheKey);
      return sign(cacheKey);
    },
    invalidate(assetsDir) {
      if (assetsDir === undefined) cache.clear();
      else cache.delete(path.resolve(assetsDir));
    },
  };
}

/** Re-derives the public key from a stored private key. */
export function publicKeyOf(privateKeyPem: string): string {
  return Buffer.from(createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' }) as Buffer).toString(
    'base64url',
  );
}
