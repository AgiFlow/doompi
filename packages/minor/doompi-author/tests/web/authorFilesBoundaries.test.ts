import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorKindForPath,
  editableStructuredFragments,
  loadAuthorDocument,
  saveAuthorDocument,
} from '../../src/web/authorFiles.ts';
import type { AuthorDocumentInput } from '../../src/web/authorViewportTypes.ts';

const sha = 'a'.repeat(64);
const document: AuthorDocumentInput = { path: 'a.csv', kind: 'csv', structuredFormat: 'csv', sourceSha256: sha };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function responses(...values: Response[]) {
  const fetch = vi.fn();
  for (const value of values) fetch.mockResolvedValueOnce(value);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe('Author file boundary failures and supported encodings', () => {
  it.each([
    ['a.MD', 'markdown'],
    ['a.JPG', 'image'],
    ['a.mp4', 'video'],
    ['a.pdf', 'pdf'],
    ['a.tsx', 'text'],
    ['a', 'opaque'],
    ['a.slides.md', 'slides'],
    ['a.xlsx', 'xlsx'],
    ['a.pptx', 'pptx'],
  ])('classifies %s as %s', (path, kind) => expect(authorKindForPath(path)).toBe(kind));
  it.each(['a.md', 'a.png', 'a.mp4', 'a.pdf', 'a.bin'])(
    'opens %s without requiring an optional digest',
    async (path) => {
      responses(new Response('text'));
      const result = await loadAuthorDocument('session /', path);
      expect(result.sourceSha256).toBeUndefined();
      if (path.endsWith('.md')) expect(result.content).toBe('text');
      else expect(result.mediaUrl).toContain('session%20%2F');
    },
  );
  it('rejects failed reads and API failures with useful server or fallback messages', async () => {
    responses(new Response('', { status: 404 }));
    await expect(loadAuthorDocument('s', 'a.md')).rejects.toThrow('404');
    for (const error of ['server rejected', undefined]) {
      responses(new Response(''), json({ error }, 500));
      await expect(loadAuthorDocument('s', 'a.csv')).rejects.toThrow(error ?? 'Author document API failed (500)');
    }
  });
  it.each([
    undefined,
    { delimiter: ',', quote: '"', recordDelimiter: '\n' },
    { delimiter: ';', quote: "'", recordDelimiter: '\r\n' },
    { delimiter: '\t', quote: '"', recordDelimiter: '\n' },
    { delimiter: '|', quote: '"', recordDelimiter: '\n' },
  ])('accepts optional valid CSV dialect metadata %j', async (metadata) => {
    responses(new Response(''), json({ fragments: [], manifest: { metadata } }));
    expect((await loadAuthorDocument('s', 'a.csv')).csvDialect).toEqual(metadata);
  });
  it.each([
    { delimiter: '!', quote: '"', recordDelimiter: '\n' },
    { delimiter: ',', quote: '!', recordDelimiter: '\n' },
    { delimiter: ',', quote: '"', recordDelimiter: '!' },
  ])('rejects invalid CSV metadata %j', async (metadata) => {
    responses(new Response(''), json({ fragments: [], manifest: { metadata } }));
    await expect(loadAuthorDocument('s', 'a.csv')).rejects.toThrow('invalid CSV dialect');
  });
  it('opens structured content without a manifest and exposes absent fragments as empty', async () => {
    responses(new Response(''), json({ fragments: [] }));
    expect((await loadAuthorDocument('s', 'a.pptx')).fragments).toEqual([]);
    expect(editableStructuredFragments(document)).toEqual([]);
    expect(editableStructuredFragments({ ...document, fragments: [] })).toEqual([]);
  });
  it.each([
    { accepted: false, issues: [] },
    { accepted: false, issues: [{ message: 'Read-only cell' }] },
    { accepted: true, sourceDigest: 'changed' },
  ])('rejects preflight without issuing a write: %j', async (report) => {
    const fetch = responses(json(report));
    await expect(saveAuthorDocument('s', document)).rejects.toThrow(
      report.sourceDigest ? 'source changed' : report.issues?.length ? 'Read-only cell' : 'preflight rejected',
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { encoding: 'utf8', bytes: 'x' },
    { encoding: 'base64', bytes: 'not base64!' },
  ])('rejects unsafe serialization %j', async (serialized) => {
    const fetch = responses(json({ accepted: true }), json(serialized));
    await expect(saveAuthorDocument('s', document)).rejects.toThrow(
      serialized.encoding === 'utf8' ? 'unsupported encoding' : 'Invalid serialized',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('serializes only changed editable fragments and forwards dialect and fences', async () => {
    const fragments: AuthorDocumentInput['fragments'] = [
      { id: 'same', text: 'old', kind: 'cell', location: 'A1' },
      { id: 'edit', text: 'new', kind: 'cell', location: 'B1' },
      { id: 'locked', text: 'new', readOnly: true, kind: 'cell', location: 'C1' },
    ];
    const fetch = responses(
      json({ accepted: true, digest: 'preflight' }),
      json({ encoding: 'base64', bytes: btoa('output') }),
      new Response('', { headers: { 'X-File-SHA256': sha } }),
    );
    expect(
      await saveAuthorDocument('s', {
        ...document,
        fragments,
        originalFragments: [
          { id: 'same', text: 'old', kind: 'cell', location: 'A1' },
          { id: 'edit', text: 'old', kind: 'cell', location: 'B1' },
        ],
        csvDialect: { delimiter: ';', quote: '"', recordDelimiter: '\n' },
      }),
    ).toBe(sha);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
      operations: [{ fragmentId: 'edit', replacement: 'new' }],
      csvDialect: { delimiter: ';' },
    });
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({ preflightDigest: 'preflight' });
    expect(new TextDecoder().decode(fetch.mock.calls[2]![1].body)).toBe('output');
  });
  it('rejects missing source fences, unsupported saves, failed writes and malformed response digests', async () => {
    await expect(saveAuthorDocument('s', { path: 'a.md', kind: 'markdown' })).rejects.toThrow('no source digest');
    await expect(saveAuthorDocument('s', { path: 'a.pdf', kind: 'pdf', sourceSha256: sha })).rejects.toThrow(
      'cannot be saved',
    );
    for (const response of [
      new Response('', { status: 409 }),
      new Response(''),
      new Response('', { headers: { 'X-File-SHA256': 'invalid' } }),
    ]) {
      responses(response);
      await expect(saveAuthorDocument('s', { path: 'a.md', kind: 'markdown', sourceSha256: sha })).rejects.toThrow(
        response.ok ? 'invalid digest' : '409',
      );
    }
  });
  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ])('preserves %s crop encoding and closes the decoded bitmap', async (extension, mime) => {
    const drawImage = vi.fn();
    const bitmap = { width: 100, height: 80, close: vi.fn() };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap),
    );
    const blob = new Blob(['image'], { type: mime });
    vi.stubGlobal('window', {
      document: {
        createElement: () => ({
          getContext: () => ({ drawImage }),
          toBlob: (callback: (blob: Blob) => void, type: string) => {
            expect(type).toBe(mime);
            callback(blob);
          },
        }),
      },
    });
    const fetch = responses(new Response('image'), new Response('', { headers: { 'X-File-SHA256': sha } }));
    await saveAuthorDocument('s', {
      path: `a.${extension}`,
      kind: 'image',
      sourceSha256: sha,
      mediaUrl: '/image',
      crop: { x: 0.1, y: 0.25, width: 0.5, height: 0.5 },
    });
    expect(drawImage).toHaveBeenCalledWith(bitmap, 10, 20, 50, 40, 0, 0, 50, 40);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[1]![1].body).toBe(blob);
  });
  it('rejects unsupported or unavailable crop sources', async () => {
    const image: AuthorDocumentInput = {
      path: 'a.png',
      kind: 'image',
      sourceSha256: sha,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    };
    await expect(saveAuthorDocument('s', image)).rejects.toThrow('no crop source');
    await expect(saveAuthorDocument('s', { ...image, path: 'a.gif', mediaUrl: '/image' })).rejects.toThrow(
      'cannot preserve',
    );
    responses(new Response('', { status: 404 }));
    await expect(saveAuthorDocument('s', { ...image, mediaUrl: '/image' })).rejects.toThrow('404');
    for (const encoded of [null, new Blob(['wrong'], { type: 'image/jpeg' }), 'no-context']) {
      const close = vi.fn();
      vi.stubGlobal('createImageBitmap', async () => ({ width: 1, height: 1, close }));
      vi.stubGlobal('window', {
        document: {
          createElement: () => ({
            getContext: () => (encoded === 'no-context' ? null : { drawImage: vi.fn() }),
            toBlob: (callback: (value: unknown) => void) => callback(encoded),
          }),
        },
      });
      responses(new Response('image'));
      await expect(saveAuthorDocument('s', { ...image, mediaUrl: '/image' })).rejects.toThrow(
        encoded === 'no-context' ? 'Canvas is unavailable' : 'cannot encode',
      );
      expect(close).toHaveBeenCalledOnce();
    }
  });
});
