import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DoomHelpContribution, DoomHelpSkill } from '@agimon-ai/doompi-extension-contracts/help';
import { renderHelpSkillWrapper } from '../services/llmsContent.ts';
import type { HelpPackageIdentity, HelpSkillMaterializer, ResolvedHelpIndex } from '../types/help.ts';

const PACKAGE_MANIFEST = 'package.json';
const HELP_INDEX_PATH = 'llms.txt';
const CACHE_SCHEMA_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const COMPLETION_FILE = '.complete';
const CACHE_METADATA_FILE = 'metadata.json';
const WRAPPER_DIRECTORY = 'wrappers';
const SKILL_FILE = 'SKILL.md';
const EXACT_SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

interface CacheMetadata {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  source: string;
  version: string;
  path: typeof HELP_INDEX_PATH;
  integrity: string;
  digest: string;
  referenceBase: string;
}

export interface CachedHelpIndex {
  bytes: Uint8Array;
  filePath: string;
  integrity: string;
  digest: string;
  referenceBase: string;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Help activation was cancelled.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readManifest(filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot read Help package manifest at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`Help package manifest at ${filePath} must contain an object.`);
  return parsed;
}

export function resolveHelpPackageIdentity(moduleUrl: string, expectedSource: string): HelpPackageIdentity {
  if (!NPM_PACKAGE_NAME_PATTERN.test(expectedSource)) {
    throw new Error(`Help source '${expectedSource}' must be a valid lowercase npm package name.`);
  }
  let modulePath: string;
  try {
    const url = new URL(moduleUrl);
    if (url.protocol !== 'file:') throw new Error(`Help module URL must use file:, received ${url.protocol}`);
    modulePath = fs.realpathSync(fileURLToPath(url));
  } catch (error) {
    throw new Error(
      `Invalid Help contributor module URL '${moduleUrl}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!fs.lstatSync(modulePath).isFile())
    throw new Error(`Help contributor module is not a regular file: ${modulePath}`);

  let directory = path.dirname(modulePath);
  while (true) {
    const manifestPath = path.join(directory, PACKAGE_MANIFEST);
    if (fs.existsSync(manifestPath)) {
      const manifest = readManifest(manifestPath);
      const source = manifest.name;
      const version = manifest.version;
      if (source !== expectedSource) {
        throw new Error(`Help source '${expectedSource}' does not match nearest package '${String(source)}'.`);
      }
      if (typeof version !== 'string' || !EXACT_SEMVER_PATTERN.test(version)) {
        throw new Error(`Help package '${expectedSource}' must declare an exact semantic version.`);
      }
      const packageRoot = fs.realpathSync(directory);
      if (!isContained(packageRoot, modulePath))
        throw new Error('Help contributor module escapes its resolved package root.');
      return { source: expectedSource, version, packageRoot, modulePath };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Cannot find a package manifest for Help contributor ${modulePath}.`);
}

export function defaultHelpCacheRoot(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.pi', '.doom', 'llms-cache');
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseCacheMetadata(value: unknown, identity: HelpPackageIdentity): CacheMetadata | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schemaVersion !== CACHE_SCHEMA_VERSION ||
    value.source !== identity.source ||
    value.version !== identity.version ||
    value.path !== HELP_INDEX_PATH ||
    typeof value.integrity !== 'string' ||
    typeof value.digest !== 'string' ||
    typeof value.referenceBase !== 'string'
  ) {
    return undefined;
  }
  return value as unknown as CacheMetadata;
}

function regularFile(filePath: string): boolean {
  try {
    const metadata = fs.lstatSync(filePath);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export class HelpIndexCache {
  readonly root: string;

  constructor(root = defaultHelpCacheRoot()) {
    this.root = root;
  }

  entryDirectory(identity: HelpPackageIdentity): string {
    const key = sha256Hex(`${identity.source}\0${identity.version}\0${HELP_INDEX_PATH}`);
    return path.join(this.root, key);
  }

  discard(identity: HelpPackageIdentity): void {
    fs.rmSync(this.entryDirectory(identity), { recursive: true, force: true });
  }

  read(identity: HelpPackageIdentity): CachedHelpIndex | undefined {
    const directory = this.entryDirectory(identity);
    const completionPath = path.join(directory, COMPLETION_FILE);
    const indexPath = path.join(directory, HELP_INDEX_PATH);
    const metadataPath = path.join(directory, CACHE_METADATA_FILE);
    if (!regularFile(completionPath) || !regularFile(indexPath) || !regularFile(metadataPath)) return undefined;
    try {
      const metadata = parseCacheMetadata(JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as unknown, identity);
      if (!metadata) return undefined;
      const bytes = fs.readFileSync(indexPath);
      if (sha256Hex(bytes) !== metadata.digest) return undefined;
      if (fs.readFileSync(completionPath, 'utf8').trim() !== metadata.digest) return undefined;
      return {
        bytes,
        filePath: indexPath,
        integrity: metadata.integrity,
        digest: metadata.digest,
        referenceBase: metadata.referenceBase,
      };
    } catch {
      return undefined;
    }
  }

  publish(
    identity: HelpPackageIdentity,
    bytes: Uint8Array,
    integrity: string,
    referenceBase: string,
    signal: AbortSignal,
  ): CachedHelpIndex {
    assertNotAborted(signal);
    const existing = this.read(identity);
    if (existing) return existing;
    const directory = this.entryDirectory(identity);
    fs.mkdirSync(this.root, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    const temporary = `${directory}.${process.pid}.${randomUUID()}.tmp`;
    const digest = sha256Hex(bytes);
    const metadata: CacheMetadata = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      source: identity.source,
      version: identity.version,
      path: HELP_INDEX_PATH,
      integrity,
      digest,
      referenceBase,
    };
    try {
      fs.mkdirSync(temporary, { mode: PRIVATE_DIRECTORY_MODE });
      fs.writeFileSync(path.join(temporary, HELP_INDEX_PATH), bytes, { mode: PRIVATE_FILE_MODE });
      fs.writeFileSync(path.join(temporary, CACHE_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, {
        mode: PRIVATE_FILE_MODE,
      });
      assertNotAborted(signal);
      fs.writeFileSync(path.join(temporary, COMPLETION_FILE), `${digest}\n`, { mode: PRIVATE_FILE_MODE });
      try {
        fs.renameSync(temporary, directory);
      } catch (error) {
        const winner = this.read(identity);
        if (winner) return winner;
        throw error;
      }
      return {
        bytes: Uint8Array.from(bytes),
        filePath: path.join(directory, HELP_INDEX_PATH),
        integrity,
        digest,
        referenceBase,
      };
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

export class DefaultHelpSkillMaterializer implements HelpSkillMaterializer {
  constructor(private readonly cacheRoot = defaultHelpCacheRoot()) {}

  async materialize(
    contribution: DoomHelpContribution,
    index: ResolvedHelpIndex,
    signal: AbortSignal,
  ): Promise<readonly DoomHelpSkill[]> {
    const skills: DoomHelpSkill[] = [];
    for (const descriptor of contribution.skills) {
      assertNotAborted(signal);
      const key = sha256Hex(
        `${index.identity.source}\0${index.identity.version}\0${descriptor.name}\0${descriptor.description}\0${index.digest}`,
      );
      const directory = path.join(this.cacheRoot, WRAPPER_DIRECTORY, key);
      const filePath = path.join(directory, SKILL_FILE);
      const content = renderHelpSkillWrapper(descriptor, index);
      if (!regularFile(filePath) || fs.readFileSync(filePath, 'utf8') !== content) {
        fs.mkdirSync(path.dirname(directory), { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
        if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
        const temporary = `${directory}.${process.pid}.${randomUUID()}.tmp`;
        try {
          fs.mkdirSync(temporary, { mode: PRIVATE_DIRECTORY_MODE });
          fs.writeFileSync(path.join(temporary, SKILL_FILE), content, { mode: PRIVATE_FILE_MODE });
          assertNotAborted(signal);
          try {
            fs.renameSync(temporary, directory);
          } catch (error) {
            if (!regularFile(filePath) || fs.readFileSync(filePath, 'utf8') !== content) throw error;
          }
        } finally {
          fs.rmSync(temporary, { recursive: true, force: true });
        }
      }
      skills.push({
        source: contribution.source,
        name: descriptor.name,
        description: descriptor.description,
        filePath,
        baseDir: directory,
      });
    }
    return skills;
  }
}
