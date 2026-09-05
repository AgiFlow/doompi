import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAuthorDocument, saveAuthorDocument } from '../../src/web/authorFiles.ts';

const SOURCE_SHA = 'a'.repeat(64);
const SAVED_SHA = 'b'.repeat(64);

afterEach(() => vi.unstubAllGlobals());

describe('Author browser file seams', () => {
  it('opens a structured document through the session file and Author document APIs', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('source', { headers: { 'X-File-SHA256': SOURCE_SHA } }))
      .mockResolvedValueOnce(
        Response.json({
          format: 'csv',
          manifest: { sourceDigest: SOURCE_SHA, metadata: { delimiter: ';', quote: '"', recordDelimiter: '\r\n' } },
          fragments: [{ id: 'cell', location: 'A1', text: 'before' }],
        }),
      );
    vi.stubGlobal('fetch', fetch);

    await expect(loadAuthorDocument('session/1', 'report.csv')).resolves.toMatchObject({
      path: 'report.csv',
      kind: 'csv',
      structuredFormat: 'csv',
      csvDialect: { delimiter: ';', quote: '"', recordDelimiter: '\r\n' },
      sourceSha256: SOURCE_SHA,
      fragments: [{ id: 'cell', location: 'A1', text: 'before' }],
      originalFragments: [{ id: 'cell', location: 'A1', text: 'before' }],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/sessions/session%2F1/file?path=report.csv');
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/plugin/author/documents/open?session=session%2F1');
    expect(JSON.parse((fetch.mock.calls[1]?.[1]?.body as string) ?? '')).toEqual({ path: 'report.csv', format: 'csv' });
  });

  it('preflights and serializes structured edits before an expected-SHA save', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ accepted: true, digest: 'digest', issues: [] }))
      .mockResolvedValueOnce(Response.json({ encoding: 'base64', bytes: 'aGk=' }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'X-File-SHA256': SAVED_SHA } }));
    vi.stubGlobal('fetch', fetch);

    await expect(
      saveAuthorDocument('session', {
        path: 'report.csv',
        kind: 'csv',
        structuredFormat: 'csv',
        csvDialect: { delimiter: ';', quote: '"', recordDelimiter: '\r\n' },
        sourceSha256: SOURCE_SHA,
        originalFragments: [{ id: 'cell', kind: 'cell', location: 'A1', text: 'before' }],
        fragments: [{ id: 'cell', kind: 'cell', location: 'A1', text: 'after' }],
      }),
    ).resolves.toBe(SAVED_SHA);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/plugin/author/documents/preflight?session=session',
      '/api/plugin/author/documents/serialize?session=session',
      '/api/sessions/session/file?path=report.csv',
    ]);
    expect(JSON.parse((fetch.mock.calls[0]?.[1]?.body as string) ?? '')).toEqual({
      path: 'report.csv',
      format: 'csv',
      csvDialect: { delimiter: ';', quote: '"', recordDelimiter: '\r\n' },
      operations: [{ fragmentId: 'cell', replacement: 'after' }],
    });
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Expected-SHA256': SOURCE_SHA },
    });
  });

  it('crops an image against intrinsic pixels before saving it with the expected digest', async () => {
    const encoded = new Blob(['cropped'], { type: 'image/png' });
    const drawImage = vi.fn();
    const close = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((resolve: (blob: Blob) => void) => resolve(encoded)),
    };
    vi.stubGlobal('window', { document: { createElement: vi.fn(() => canvas) } });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1000, height: 500, close })),
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(new Blob(['source'], { type: 'image/png' })))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'X-File-SHA256': SAVED_SHA } }));
    vi.stubGlobal('fetch', fetch);

    await expect(
      saveAuthorDocument('session', {
        path: 'photo.png',
        kind: 'image',
        mediaUrl: '/api/sessions/session/file?path=photo.png',
        sourceSha256: SOURCE_SHA,
        crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
      }),
    ).resolves.toBe(SAVED_SHA);

    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 100, 100, 500, 200, 0, 0, 500, 200);
    expect(canvas).toMatchObject({ width: 500, height: 200 });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      body: encoded,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Expected-SHA256': SOURCE_SHA },
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it('rejects a source change between the file response and structured parsing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response('source', { headers: { 'X-File-SHA256': SOURCE_SHA } }))
        .mockResolvedValueOnce(Response.json({ manifest: { sourceDigest: SAVED_SHA }, fragments: [] })),
    );
    await expect(loadAuthorDocument('session', 'report.csv')).rejects.toThrow('source changed while opening');
  });

  it('does not serialize or write when preflight inspected a different source', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ accepted: true, digest: 'digest', sourceDigest: SAVED_SHA, issues: [] }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      saveAuthorDocument('session', {
        path: 'report.csv',
        kind: 'csv',
        structuredFormat: 'csv',
        sourceSha256: SOURCE_SHA,
      }),
    ).rejects.toThrow('source changed before saving');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
