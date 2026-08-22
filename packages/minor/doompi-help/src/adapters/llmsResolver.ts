import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DoomHelpContribution } from '@agimon-ai/doompi-extension-contracts/help';
import { MAX_LLMS_BYTES, validateLlmsBytes } from '../services/llmsContent.ts';
import type { HelpFetch, HelpFetchResponse, HelpIndexResolver, ResolvedHelpIndex } from '../types/help.ts';
import { HelpIndexCache, resolveHelpPackageIdentity, sha256Hex } from './helpStorage.ts';

const HELP_INDEX_PATH = 'llms.txt';
const UNPKG_ORIGIN = 'https://unpkg.com';
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const SRI_PATTERN = /^sha256-([A-Za-z0-9+/]+={0,2})$/u;

interface UnpkgMetadataFile {
  path: string;
  size?: number;
  integrity: string;
}

export interface DefaultHelpIndexResolverOptions {
  cache?: HelpIndexCache;
  fetch?: HelpFetch;
  timeoutMs?: number;
}

function defaultFetch(input: string, init: { signal: AbortSignal; redirect: 'manual' }): Promise<HelpFetchResponse> {
  return fetch(input, init) as unknown as Promise<HelpFetchResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRegularFile(filePath: string): boolean {
  try {
    const metadata = fs.lstatSync(filePath);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function unpkgPackagePath(source: string, version: string): string {
  const encoded = source
    .split('/')
    .map((segment) =>
      segment.startsWith('@') ? `@${encodeURIComponent(segment.slice(1))}` : encodeURIComponent(segment),
    )
    .join('/');
  return `${encoded}@${encodeURIComponent(version)}`;
}

function exactUnpkgBase(source: string, version: string): string {
  return `${UNPKG_ORIGIN}/${unpkgPackagePath(source, version)}/`;
}

function contentLength(response: HelpFetchResponse): number | undefined {
  const raw = response.headers.get('content-length');
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function timeoutSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Help download timed out.')), timeoutMs);
  if (parent.aborted) abort();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    },
  };
}

async function fetchExact(fetcher: HelpFetch, initialUrl: string, signal: AbortSignal): Promise<HelpFetchResponse> {
  let url = initialUrl;
  const expected = new URL(initialUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetcher(url, { signal, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error(`Unpkg redirected ${url} without a location.`);
    const next = new URL(location, url);
    if (next.origin !== UNPKG_ORIGIN || next.pathname !== expected.pathname || next.search !== expected.search) {
      throw new Error(`Unpkg redirect escaped the exact package/version path: ${next.href}`);
    }
    url = next.href;
  }
  throw new Error(`Unpkg exceeded ${MAX_REDIRECTS} redirects.`);
}

function parseMetadata(text: string): UnpkgMetadataFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Unpkg metadata is not valid JSON.');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) throw new Error('Unpkg metadata has no files list.');
  const match = parsed.files.find((entry) => isRecord(entry) && entry.path === `/${HELP_INDEX_PATH}`);
  if (!isRecord(match) || typeof match.integrity !== 'string') {
    throw new Error(`Unpkg package does not publish /${HELP_INDEX_PATH}.`);
  }
  const size = typeof match.size === 'number' ? match.size : undefined;
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_LLMS_BYTES)) {
    throw new Error(`Unpkg /${HELP_INDEX_PATH} exceeds the Help size limit.`);
  }
  if (!SRI_PATTERN.test(match.integrity)) throw new Error('Unpkg llms.txt metadata does not contain SHA-256 SRI.');
  return { path: match.path as string, ...(size === undefined ? {} : { size }), integrity: match.integrity };
}

function verifySri(bytes: Uint8Array, integrity: string): void {
  const expected = SRI_PATTERN.exec(integrity)?.[1];
  if (!expected) throw new Error('Invalid llms.txt SRI metadata.');
  const actual = createHash('sha256').update(bytes).digest('base64');
  if (actual !== expected) throw new Error('Downloaded llms.txt failed SRI verification.');
}

export class DefaultHelpIndexResolver implements HelpIndexResolver {
  private readonly cache: HelpIndexCache;
  private readonly fetcher: HelpFetch;
  private readonly timeoutMs: number;

  constructor(options: DefaultHelpIndexResolverOptions = {}) {
    this.cache = options.cache ?? new HelpIndexCache();
    this.fetcher = options.fetch ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async resolve(contribution: DoomHelpContribution, signal: AbortSignal): Promise<ResolvedHelpIndex> {
    if (signal.aborted) throw new Error('Help activation was cancelled.');
    const identity = resolveHelpPackageIdentity(contribution.moduleUrl, contribution.source);
    const localPath = path.join(identity.packageRoot, HELP_INDEX_PATH);
    if (fs.existsSync(localPath)) {
      if (!isRegularFile(localPath)) throw new Error(`Bundled ${HELP_INDEX_PATH} must be a regular file.`);
      const bytes = fs.readFileSync(localPath);
      validateLlmsBytes(bytes);
      return {
        identity,
        location: 'local',
        filePath: localPath,
        referenceBase: identity.packageRoot,
        byteLength: bytes.byteLength,
        digest: sha256Hex(bytes),
      };
    }

    const cached = this.cache.read(identity);
    if (cached) {
      try {
        validateLlmsBytes(cached.bytes);
        return {
          identity,
          location: 'cache',
          filePath: cached.filePath,
          referenceBase: cached.referenceBase,
          byteLength: cached.bytes.byteLength,
          digest: cached.digest,
        };
      } catch {
        this.cache.discard(identity);
      }
    }

    const timed = timeoutSignal(signal, this.timeoutMs);
    try {
      const referenceBase = exactUnpkgBase(identity.source, identity.version);
      const metadataResponse = await fetchExact(this.fetcher, `${referenceBase}?meta`, timed.signal);
      const metadataLength = contentLength(metadataResponse);
      if (metadataLength !== undefined && metadataLength > MAX_METADATA_BYTES) {
        throw new Error('Unpkg metadata exceeds the Help metadata size limit.');
      }
      if (!metadataResponse.ok) throw new Error(`Unpkg metadata request failed with HTTP ${metadataResponse.status}.`);
      const metadataText = await metadataResponse.text();
      if (Buffer.byteLength(metadataText, 'utf8') > MAX_METADATA_BYTES) {
        throw new Error('Unpkg metadata exceeds the Help metadata size limit.');
      }
      const metadata = parseMetadata(metadataText);
      const indexResponse = await fetchExact(this.fetcher, `${referenceBase}${HELP_INDEX_PATH}`, timed.signal);
      const indexLength = contentLength(indexResponse);
      if (indexLength !== undefined && indexLength > MAX_LLMS_BYTES) {
        throw new Error(`Downloaded ${HELP_INDEX_PATH} exceeds ${MAX_LLMS_BYTES} bytes.`);
      }
      if (!indexResponse.ok) throw new Error(`Unpkg llms.txt request failed with HTTP ${indexResponse.status}.`);
      const bytes = new Uint8Array(await indexResponse.arrayBuffer());
      validateLlmsBytes(bytes);
      verifySri(bytes, metadata.integrity);
      const published = this.cache.publish(identity, bytes, metadata.integrity, referenceBase, timed.signal);
      return {
        identity,
        location: 'remote',
        filePath: published.filePath,
        referenceBase: published.referenceBase,
        byteLength: published.bytes.byteLength,
        digest: published.digest,
      };
    } finally {
      timed.dispose();
    }
  }
}
