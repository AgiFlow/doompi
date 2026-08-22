import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHARED_BUILD_SCHEMA = 1;
const OBJECTS_DIRECTORY = 'objects';
const INDEX_DIRECTORY = 'index';
const LOCKS_DIRECTORY = 'locks';
const MANIFEST_FILE = 'manifest.json';
const OWNER_FILE = 'owner.json';
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 25;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface SharedBuildInput {
  logicalPath: string;
  sha256: string;
  token: string;
  /** Canonical source path for inputs outside the synchronized repository. */
  sourcePath?: string;
}

export interface SharedBuildArtifact {
  path: string;
  sha256: string;
}

export interface SharedBuildManifest {
  schema: number;
  key: string;
  lookupKey: string;
  entry: string;
  inputs: SharedBuildInput[];
  artifacts: SharedBuildArtifact[];
}

export interface ResolvedSharedBuild {
  directory: string;
  manifest: SharedBuildManifest;
  replacements: ReadonlyMap<string, string>;
}

interface SharedBuildIndex {
  schema: number;
  keys: string[];
}

export interface PublishSharedBuildOptions {
  cacheDirectory: string;
  lookupKey: string;
  entry: string;
  inputs: SharedBuildInput[];
  artifacts: ReadonlyMap<string, string | Uint8Array>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function contentSha256(contents: string | Uint8Array): string {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function safeRelativePath(value: string): string | undefined {
  if (value === '' || path.isAbsolute(value)) return undefined;
  const normalized = path.normalize(value);
  return normalized === '..' || normalized.startsWith(`..${path.sep}`) ? undefined : normalized;
}

function parseManifest(value: unknown): SharedBuildManifest | undefined {
  if (
    !isRecord(value) ||
    value.schema !== SHARED_BUILD_SCHEMA ||
    typeof value.key !== 'string' ||
    !SHA256_PATTERN.test(value.key) ||
    typeof value.lookupKey !== 'string' ||
    !SHA256_PATTERN.test(value.lookupKey) ||
    typeof value.entry !== 'string' ||
    !Array.isArray(value.inputs) ||
    !Array.isArray(value.artifacts)
  ) {
    return undefined;
  }
  const inputs: SharedBuildInput[] = [];
  for (const input of value.inputs) {
    if (
      !isRecord(input) ||
      typeof input.logicalPath !== 'string' ||
      typeof input.sha256 !== 'string' ||
      (input.sha256 !== '' && !SHA256_PATTERN.test(input.sha256)) ||
      typeof input.token !== 'string' ||
      (input.sourcePath !== undefined && (typeof input.sourcePath !== 'string' || !path.isAbsolute(input.sourcePath)))
    ) {
      return undefined;
    }
    inputs.push({
      logicalPath: input.logicalPath,
      sha256: input.sha256,
      token: input.token,
      ...(typeof input.sourcePath === 'string' ? { sourcePath: input.sourcePath } : {}),
    });
  }
  const artifacts: SharedBuildArtifact[] = [];
  for (const artifact of value.artifacts) {
    if (
      !isRecord(artifact) ||
      typeof artifact.path !== 'string' ||
      typeof artifact.sha256 !== 'string' ||
      !SHA256_PATTERN.test(artifact.sha256)
    ) {
      return undefined;
    }
    if (!safeRelativePath(artifact.path)) return undefined;
    artifacts.push({ path: artifact.path, sha256: artifact.sha256 });
  }
  if (!safeRelativePath(value.entry)) return undefined;
  return {
    schema: SHARED_BUILD_SCHEMA,
    key: value.key,
    lookupKey: value.lookupKey,
    entry: value.entry,
    inputs,
    artifacts,
  };
}

function readJson(target: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function writeAtomic(target: string, contents: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: PRIVATE_FILE_MODE });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, PRIVATE_FILE_MODE);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function indexPath(cacheDirectory: string, lookupKey: string): string {
  return path.join(cacheDirectory, INDEX_DIRECTORY, `${lookupKey}.json`);
}

function readIndex(cacheDirectory: string, lookupKey: string): SharedBuildIndex {
  const parsed = readJson(indexPath(cacheDirectory, lookupKey));
  if (!isRecord(parsed) || parsed.schema !== SHARED_BUILD_SCHEMA || !Array.isArray(parsed.keys)) {
    return { schema: SHARED_BUILD_SCHEMA, keys: [] };
  }
  return {
    schema: SHARED_BUILD_SCHEMA,
    keys: parsed.keys.filter((key): key is string => typeof key === 'string'),
  };
}

function writeIndex(cacheDirectory: string, lookupKey: string, key: string): void {
  const current = readIndex(cacheDirectory, lookupKey);
  const keys = [key, ...current.keys.filter((candidate) => candidate !== key)];
  writeAtomic(
    indexPath(cacheDirectory, lookupKey),
    `${JSON.stringify({ schema: SHARED_BUILD_SCHEMA, keys }, null, 2)}\n`,
  );
}

function objectDirectory(cacheDirectory: string, key: string): string {
  return path.join(cacheDirectory, OBJECTS_DIRECTORY, key);
}

function artifactBytes(directory: string, artifact: SharedBuildArtifact): Buffer | undefined {
  const relative = safeRelativePath(artifact.path);
  if (!relative) return undefined;
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) return undefined;
    const target = path.join(directory, relative);
    if (fs.lstatSync(target).isSymbolicLink()) return undefined;
    const canonicalDirectory = fs.realpathSync(directory);
    const canonicalTarget = fs.realpathSync(target);
    const confined = path.relative(canonicalDirectory, canonicalTarget);
    if (confined.startsWith('..') || path.isAbsolute(confined)) return undefined;
    const bytes = fs.readFileSync(canonicalTarget);
    return contentSha256(bytes) === artifact.sha256 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export function findSharedBuild(
  cacheDirectory: string,
  lookupKey: string,
  resolveInput: (input: SharedBuildInput) => string | undefined,
): ResolvedSharedBuild | undefined {
  if (!SHA256_PATTERN.test(lookupKey)) return undefined;
  for (const key of readIndex(cacheDirectory, lookupKey).keys) {
    if (!SHA256_PATTERN.test(key)) continue;
    const directory = objectDirectory(cacheDirectory, key);
    const manifest = parseManifest(readJson(path.join(directory, MANIFEST_FILE)));
    if (!manifest || manifest.key !== key || manifest.lookupKey !== lookupKey || !manifestKeyMatches(manifest))
      continue;
    if (manifest.artifacts.some((artifact) => artifactBytes(directory, artifact) === undefined)) continue;
    const replacements = new Map<string, string>();
    let valid = true;
    for (const input of manifest.inputs) {
      const target = resolveInput(input);
      if (!target) {
        valid = false;
        break;
      }
      if (input.sha256 !== '') {
        try {
          if (contentSha256(fs.readFileSync(target)) !== input.sha256) {
            valid = false;
            break;
          }
        } catch {
          valid = false;
          break;
        }
      }
      replacements.set(input.token, target);
    }
    if (valid) return { directory, manifest, replacements };
  }
  return undefined;
}

function manifestKey(
  options: Omit<PublishSharedBuildOptions, 'cacheDirectory'>,
  artifacts: SharedBuildArtifact[],
): string {
  return contentSha256(
    JSON.stringify({
      schema: SHARED_BUILD_SCHEMA,
      lookupKey: options.lookupKey,
      entry: options.entry,
      inputs: options.inputs,
      artifacts,
    }),
  );
}

function manifestKeyMatches(manifest: SharedBuildManifest): boolean {
  return (
    manifest.key ===
    manifestKey(
      {
        lookupKey: manifest.lookupKey,
        entry: manifest.entry,
        inputs: manifest.inputs,
        artifacts: new Map(),
      },
      manifest.artifacts,
    )
  );
}

function sharedObjectMatches(directory: string, expected: SharedBuildManifest): boolean {
  const current = parseManifest(readJson(path.join(directory, MANIFEST_FILE)));
  if (!current || current.key !== expected.key || !manifestKeyMatches(current)) return false;
  return expected.artifacts.every((artifact) => artifactBytes(directory, artifact) !== undefined);
}

export function publishSharedBuild(options: PublishSharedBuildOptions): SharedBuildManifest {
  if (!SHA256_PATTERN.test(options.lookupKey)) {
    throw new Error(`Shared build lookup key must be a full SHA-256 digest: ${options.lookupKey}`);
  }
  if (options.inputs.some((input) => input.sourcePath !== undefined && !path.isAbsolute(input.sourcePath))) {
    throw new Error('Shared build external source paths must be absolute');
  }
  const artifacts = [...options.artifacts.entries()]
    .map(([artifactPath, contents]) => {
      const relative = safeRelativePath(artifactPath);
      if (!relative) throw new Error(`Shared build artifact escapes its object: ${artifactPath}`);
      return { path: relative, sha256: contentSha256(contents) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const inputs = [...options.inputs].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  const key = manifestKey({ ...options, inputs }, artifacts);
  const manifest: SharedBuildManifest = {
    schema: SHARED_BUILD_SCHEMA,
    key,
    lookupKey: options.lookupKey,
    entry: options.entry,
    inputs,
    artifacts,
  };
  const finalDirectory = objectDirectory(options.cacheDirectory, key);
  if (fs.existsSync(finalDirectory) && !sharedObjectMatches(finalDirectory, manifest)) {
    fs.rmSync(finalDirectory, { recursive: true, force: true });
  }
  if (!fs.existsSync(finalDirectory)) {
    const temporaryDirectory = `${finalDirectory}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(temporaryDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      for (const [artifactPath, contents] of options.artifacts) {
        const relative = safeRelativePath(artifactPath);
        if (!relative) throw new Error(`Shared build artifact escapes its object: ${artifactPath}`);
        const target = path.join(temporaryDirectory, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
        fs.writeFileSync(target, contents, { mode: PRIVATE_FILE_MODE });
      }
      fs.writeFileSync(path.join(temporaryDirectory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: PRIVATE_FILE_MODE,
      });
      fs.mkdirSync(path.dirname(finalDirectory), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      try {
        fs.renameSync(temporaryDirectory, finalDirectory);
      } catch (error) {
        if (!fs.existsSync(finalDirectory)) throw error;
      }
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  writeIndex(options.cacheDirectory, options.lookupKey, key);
  return manifest;
}

export function materializeSharedBuild(build: ResolvedSharedBuild, outputDirectory: string): string {
  const replacements = [...build.replacements.entries()].sort(([left], [right]) => right.length - left.length);
  for (const artifact of build.manifest.artifacts) {
    const bytes = artifactBytes(build.directory, artifact);
    if (!bytes) throw new Error(`Shared build artifact is corrupt: ${artifact.path}`);
    let contents: string | Uint8Array = bytes;
    if (artifact.path.endsWith('.mjs')) {
      let source = bytes.toString('utf8');
      for (const [token, target] of replacements) {
        source = source.replaceAll(`${token}:url`, pathToFileURL(target).href).replaceAll(token, target);
      }
      if (source.includes('__DOOMPI_PATH_'))
        throw new Error(`Shared build left unresolved path tokens in ${artifact.path}`);
      contents = source;
    }
    writeAtomic(path.join(outputDirectory, artifact.path), contents);
  }
  return path.join(outputDirectory, build.manifest.entry);
}

function processAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function lockIsStale(lockDirectory: string): boolean {
  const owner = readJson(path.join(lockDirectory, OWNER_FILE));
  if (!isRecord(owner) || typeof owner.pid !== 'number' || typeof owner.createdAt !== 'number') return true;
  return Date.now() - owner.createdAt > LOCK_STALE_MS && !processAlive(owner.pid);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function withSharedBuildLock<T>(
  cacheDirectory: string,
  lookupKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!SHA256_PATTERN.test(lookupKey)) {
    throw new Error(`Shared build lock key must be a full SHA-256 digest: ${lookupKey}`);
  }
  const lockDirectory = path.join(cacheDirectory, LOCKS_DIRECTORY, `${lookupKey}.lock`);
  fs.mkdirSync(path.dirname(lockDirectory), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDirectory, { mode: PRIVATE_DIRECTORY_MODE });
      fs.writeFileSync(
        path.join(lockDirectory, OWNER_FILE),
        `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
        { mode: PRIVATE_FILE_MODE },
      );
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      if (lockIsStale(lockDirectory)) {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for shared build lock ${lookupKey}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await operation();
  } finally {
    fs.rmSync(lockDirectory, { recursive: true, force: true });
  }
}
