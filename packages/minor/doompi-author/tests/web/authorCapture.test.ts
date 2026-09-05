import { describe, expect, it } from 'vitest';
import {
  AUTHOR_PACKET_MAX_BYTES,
  attachAuthorCapture,
  authorCaptureContext,
  createAuthorCapturePacket,
  type AuthorCaptureProvider,
} from '../../src/web/authorCapture.ts';
import type { AuthorRegionDraft } from '../../src/web/authorViewportTypes.ts';
import type { AuthorWorkspaceDocument } from '../../src/web/authorWorkspaceStore.ts';

const document: AuthorWorkspaceDocument = {
  path: 'notes.md',
  kind: 'markdown',
  content: 'hello',
  sourceSha256: 'abc',
  annotations: [],
  revisions: [],
  saveRequest: 0,
  version: 2,
  savedVersion: 2,
};

const region = (id: string, comment = 'change this', quote = 'hello'): AuthorRegionDraft => ({
  id,
  documentPath: document.path,
  revision: document.version,
  sourceSha256: document.sourceSha256,
  comment,
  quote,
  anchor: { kind: 'text-range', startOffset: 0, endOffset: 5, startLine: 1, endLine: 1 },
  viewport: { width: 800, height: 600, scrollY: 10 },
  createdAt: 1,
});

describe('Author multi-region capture packet', () => {
  it('serializes ordered native regions as valid bounded JSON', () => {
    const packet = createAuthorCapturePacket('capture-1', 10, document, [
      region('r1'),
      region('r2', 'second', 'é'.repeat(5_000)),
    ]);
    const context = authorCaptureContext(packet);
    const decoded = JSON.parse(context.content) as typeof packet;

    expect(context).toMatchObject({ source: 'author', kind: 'author-capture', id: 'capture-1' });
    expect(decoded.regions.map(({ id, ordinal }) => [id, ordinal])).toEqual([
      ['r1', 1],
      ['r2', 2],
    ]);
    expect(new TextEncoder().encode(decoded.regions[1]!.quote).byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(new TextEncoder().encode(context.content).byteLength).toBeLessThanOrEqual(AUTHOR_PACKET_MAX_BYTES);
  });

  it('rejects stale, missing, excess, and oversized comments without mutating drafts', () => {
    const drafts = [region('r1')];
    expect(() => createAuthorCapturePacket('capture', 1, document, [])).toThrow('between 1 and 16');
    expect(() =>
      createAuthorCapturePacket(
        'capture',
        1,
        document,
        Array.from({ length: 17 }, (_, index) => region(String(index))),
      ),
    ).toThrow('between 1 and 16');
    expect(() => createAuthorCapturePacket('capture', 1, document, [{ ...region('r1'), revision: 1 }])).toThrow(
      'stale',
    );
    expect(() => createAuthorCapturePacket('capture', 1, document, [region('r1', 'é'.repeat(1_025))])).toThrow('2 KiB');
    expect(drafts[0]!.comment).toBe('change this');
  });

  it('attaches exactly one image with the packet context', async () => {
    const provider: AuthorCaptureProvider = {
      capture: async () => ({ data: 'encoded', mimeType: 'image/png' }),
    };
    const attached: unknown[] = [];
    const context = authorCaptureContext(createAuthorCapturePacket('capture', 1, document, [region('r1')]));

    await attachAuthorCapture(provider, context, (capture) => attached.push(capture));

    expect(attached).toEqual([{ data: 'encoded', mimeType: 'image/png', context }]);
  });
});
