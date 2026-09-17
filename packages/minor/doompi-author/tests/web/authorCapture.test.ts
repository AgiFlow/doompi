import { describe, expect, it } from 'vitest';

import {
  AUTHOR_PACKET_MAX_BYTES,
  attachAuthorCapture,
  authorCaptureContext,
  createAuthorCapturePacket,
  type AuthorCaptureProvider,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorCapture';
import type { AuthorRegionDraft } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorViewportTypes';
import type { AuthorWorkspaceDocument } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorWorkspaceStore';

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
    const decoded = JSON.parse(context.metadata!) as typeof packet;

    expect(context).toMatchObject({
      source: 'author',
      kind: 'author-capture',
      id: 'capture-1',
      content: expect.stringContaining('(1) change this [line 1]'),
    });
    expect(context.content).toContain('(2) second');
    expect(context.content).not.toContain('captureId');
    expect(decoded.regions.map(({ id, ordinal }) => [id, ordinal])).toEqual([
      ['r1', 1],
      ['r2', 2],
    ]);
    expect(decoded.regions.map(({ ordinal, comment }) => ({ ordinal, comment }))).toEqual([
      { ordinal: 1, comment: 'change this' },
      { ordinal: 2, comment: 'second' },
    ]);
    expect(decoded.regions[0]!.quote).toBe('hello');
    expect(new TextEncoder().encode(decoded.regions[1]!.quote).byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(new TextEncoder().encode(context.metadata!).byteLength).toBeLessThanOrEqual(AUTHOR_PACKET_MAX_BYTES);
  });

  it('puts story source provenance and edit guidance in model-visible content', () => {
    const storyPreview = {
      version: 1 as const,
      provider: 'style-system',
      projectPath: 'apps/site',
      storyPath: 'src/Button.stories.tsx',
      storyExport: 'Primary',
      buildRevision: 'build-7',
      viewport: { width: 1024, height: 768 },
      sources: [
        { path: 'apps/site/src/Button.stories.tsx', sha256: 'story-sha' },
        { path: 'apps/site/src/Button.tsx', sha256: 'component-sha' },
      ],
    };
    const previewDocument: AuthorWorkspaceDocument = {
      ...document,
      path: 'author-preview/style-system/button-primary',
      kind: 'story-preview',
      storyPreview,
    };
    const previewRegion: AuthorRegionDraft = {
      ...region('preview'),
      documentPath: previewDocument.path,
      anchor: {
        kind: 'story-preview-rect',
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        preview: storyPreview,
      },
    };

    const context = authorCaptureContext(
      createAuthorCapturePacket('capture-preview', 10, previewDocument, [previewRegion]),
    );

    expect(context.content).toContain('Story: src/Button.stories.tsx#Primary');
    expect(context.content).toContain('apps/site/src/Button.tsx (sha256 component-sha)');
    expect(context.content).toContain('edit these sources, never the generated preview artifact');
    expect(context.content).toContain('rebuild the preview');
    expect(context.content).toContain('[story preview x 10%, y 20%, w 30%, h 40%]');
  });

  it('requires provenance for story-preview captures', () => {
    expect(() =>
      createAuthorCapturePacket('capture-preview', 10, { ...document, kind: 'story-preview' }, [region('preview')]),
    ).toThrow('requires source provenance');
  });

  it('includes concise video timestamps and spatial anchors in model-visible text', () => {
    const video = {
      ...region('video'),
      anchor: {
        kind: 'video-time-rect' as const,
        timeSeconds: 12.3456,
        frame: 370,
        rect: { x: 0.25, y: 0.5, width: 0.125, height: 0.2 },
      },
    };
    const context = authorCaptureContext(createAuthorCapturePacket('capture-video', 10, document, [video]));

    expect(context.content).toContain('(1) change this [time 12.346s, frame 370, x 25%, y 50%, w 12.5%, h 20%]');
    expect(context.content).not.toContain('"timeSeconds"');
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
