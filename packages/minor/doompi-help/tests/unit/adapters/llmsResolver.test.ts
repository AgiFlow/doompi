import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpIndexCache, resolveHelpPackageIdentity } from '../../../src/adapters/helpStorage.ts';
import { DefaultHelpIndexResolver } from '../../../src/adapters/llmsResolver.ts';
import type { HelpFetch, HelpFetchResponse } from '../../../src/types/help.ts';

const SOURCE = '@agimon-ai/example-help';
const VERSION = '1.2.3';

function response(body: string | Uint8Array, status = 200, headers: Record<string, string> = {}): HelpFetchResponse {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

function sri(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

describe('llms.txt resolver', () => {
  let temporaryRoot: string;
  let packageRoot: string;
  let modulePath: string;
  let cache: HelpIndexCache;
  let contribution: { source: string; moduleUrl: string; skills: { name: string; description: string }[] };

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-help-resolver-'));
    packageRoot = path.join(temporaryRoot, 'package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: SOURCE, version: VERSION }));
    modulePath = path.join(packageRoot, 'dist', 'extension.mjs');
    fs.writeFileSync(modulePath, 'export default () => {};\n');
    packageRoot = fs.realpathSync(packageRoot);
    modulePath = fs.realpathSync(modulePath);
    cache = new HelpIndexCache(path.join(temporaryRoot, 'cache'));
    contribution = {
      source: SOURCE,
      moduleUrl: pathToFileURL(modulePath).href,
      skills: [{ name: 'example-help', description: 'Explain the example.' }],
    };
  });

  afterEach(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  it('uses a bundled package-root index without performing network access', async () => {
    fs.writeFileSync(path.join(packageRoot, 'llms.txt'), '# Bundled Help\n\n[Guide](docs/guide.md)\n');
    const fetcher = vi.fn<HelpFetch>();
    const resolver = new DefaultHelpIndexResolver({ cache, fetch: fetcher });

    const resolved = await resolver.resolve(contribution, new AbortController().signal);

    expect(resolved).toMatchObject({ location: 'local', referenceBase: packageRoot });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses a verified exact-version cache while offline', async () => {
    const identity = resolveHelpPackageIdentity(contribution.moduleUrl, SOURCE);
    const bytes = new TextEncoder().encode('# Cached Help\n');
    cache.publish(
      identity,
      bytes,
      sri(bytes),
      'https://unpkg.com/@agimon-ai/example-help@1.2.3/',
      new AbortController().signal,
    );
    const fetcher = vi.fn<HelpFetch>(() => Promise.reject(new Error('offline')));
    const resolver = new DefaultHelpIndexResolver({ cache, fetch: fetcher });

    const resolved = await resolver.resolve(contribution, new AbortController().signal);

    expect(resolved).toMatchObject({ location: 'cache', byteLength: bytes.byteLength });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('downloads only exact unpkg metadata and SRI-verified llms.txt, then publishes cache bytes', async () => {
    const bytes = new TextEncoder().encode('# Remote Help\n\n[Guide](docs/guide.md)\n');
    const integrity = sri(bytes);
    const fetcher = vi.fn<HelpFetch>(async (url) => {
      if (url.endsWith('?meta')) {
        return response(JSON.stringify({ files: [{ path: '/llms.txt', size: bytes.byteLength, integrity }] }));
      }
      return response(bytes, 200, { 'content-length': String(bytes.byteLength) });
    });
    const resolver = new DefaultHelpIndexResolver({ cache, fetch: fetcher });

    const resolved = await resolver.resolve(contribution, new AbortController().signal);

    expect(resolved).toMatchObject({
      location: 'remote',
      referenceBase: 'https://unpkg.com/@agimon-ai/example-help@1.2.3/',
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://unpkg.com/@agimon-ai/example-help@1.2.3/?meta',
      'https://unpkg.com/@agimon-ai/example-help@1.2.3/llms.txt',
    ]);
    expect(fs.readFileSync(resolved.filePath)).toEqual(Buffer.from(bytes));
  });

  it('rejects SRI mismatches and redirects outside the exact unpkg path', async () => {
    const bytes = new TextEncoder().encode('# Remote Help\n');
    const badSriFetch = vi.fn<HelpFetch>(async (url) =>
      url.endsWith('?meta')
        ? response(
            JSON.stringify({ files: [{ path: '/llms.txt', integrity: sri(new TextEncoder().encode('other')) }] }),
          )
        : response(bytes),
    );
    await expect(
      new DefaultHelpIndexResolver({ cache, fetch: badSriFetch }).resolve(contribution, new AbortController().signal),
    ).rejects.toThrowError('SRI verification');

    const redirectFetch = vi.fn<HelpFetch>(async () =>
      response('', 302, { location: 'https://evil.example/latest/llms.txt' }),
    );
    await expect(
      new DefaultHelpIndexResolver({ cache, fetch: redirectFetch }).resolve(contribution, new AbortController().signal),
    ).rejects.toThrowError('escaped the exact package/version path');
  });

  it.each([
    [JSON.stringify({}), 'no files list'],
    [JSON.stringify({ files: [] }), 'does not publish'],
    [JSON.stringify({ files: [{ path: '/llms.txt', integrity: 'sha512-invalid' }] }), 'SHA-256 SRI'],
    ['not-json', 'not valid JSON'],
  ])('rejects invalid unpkg metadata %#', async (metadata, message) => {
    const fetcher = vi.fn<HelpFetch>(async () => response(metadata));

    await expect(
      new DefaultHelpIndexResolver({ cache, fetch: fetcher }).resolve(contribution, new AbortController().signal),
    ).rejects.toThrowError(message);
  });

  it('propagates cancellation and a bounded download timeout', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(new DefaultHelpIndexResolver({ cache }).resolve(contribution, cancelled.signal)).rejects.toThrowError(
      'cancelled',
    );

    const waitingFetch: HelpFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    await expect(
      new DefaultHelpIndexResolver({ cache, fetch: waitingFetch, timeoutMs: 5 }).resolve(
        contribution,
        new AbortController().signal,
      ),
    ).rejects.toThrowError('timed out');
  });
});
