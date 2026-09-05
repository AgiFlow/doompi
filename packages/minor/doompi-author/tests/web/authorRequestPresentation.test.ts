import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthorRequestLog } from '../../src/web/AuthorRequestLog.tsx';
import type { AuthorNativeAnchor, AuthorRegionDraft, AuthorRequestRecord } from '../../src/web/authorViewportTypes.ts';
const rect = { x: 0, y: 0, width: 1, height: 1 };
const region: AuthorRegionDraft = {
  id: 'r',
  documentPath: 'doc',
  revision: 0,
  comment: 'Edit',
  anchor: { kind: 'text-range', startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
  viewport: { width: 1, height: 1 },
  createdAt: 1,
};
const request: AuthorRequestRecord = {
  id: 'q',
  documentPath: 'doc',
  revision: 0,
  requestText: 'Instruction',
  regions: [region],
  status: 'REQUESTED',
  createdAt: 1,
  updatedAt: 1,
};
const render = (...requests: AuthorRequestRecord[]) =>
  renderToStaticMarkup(createElement(AuthorRequestLog, { requests }));
describe('Author request presentation boundaries', () => {
  it('renders the empty state', () => expect(render()).toContain('No requests or changes yet.'));
  it.each([
    ['REQUESTED', '1 region queued'],
    ['CHANGING', '1 region queued'],
    ['CHANGED', 'Changes applied'],
    ['COMPLETE', 'Saved to document'],
    ['FAILED', 'Stopped with an error'],
    ['CANCELLED', 'Stopped before completion'],
  ] as const)('describes %s progress', (status, text) => expect(render({ ...request, status })).toContain(text));
  it.each<[AuthorNativeAnchor, string]>([
    [{ kind: 'text-range', startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 }, 'Line 1'],
    [{ kind: 'text-range', startOffset: 0, endOffset: 1, startLine: 1, endLine: 2 }, 'Lines 1–2'],
    [{ kind: 'cell', fragmentId: 'f', location: 'A1', sheet: 'Sheet1' }, 'Sheet1 · A1'],
    [{ kind: 'cell', fragmentId: 'f', location: 'A1' }, 'A1'],
    [{ kind: 'slide-element', fragmentId: 'f', slide: 2, location: 'title' }, 'Slide 2 · title'],
    [{ kind: 'image-rect', rect, naturalWidth: 1, naturalHeight: 1 }, 'Image region'],
    [{ kind: 'pdf-page-rect', rect, page: 3 }, 'Page 3'],
    [{ kind: 'video-time-rect', rect, timeSeconds: 65.5 }, 'Video 1:05'],
  ])('labels native anchor %j', (anchor, label) =>
    expect(render({ ...request, regions: [{ ...region, anchor }] })).toContain(label),
  );
  it('shows errors and either side of a preview independently', () => {
    const before = render({ ...request, status: 'FAILED', before: 'original', error: 'Conflict', requestText: '' });
    expect(before).toContain('before: original');
    expect(before).not.toContain('after:');
    expect(before).toContain('Conflict');
    expect(before).toContain('No additional instruction.');
    const after = render({ ...request, after: 'replacement', currentOperation: 'Saving', documentPath: '/' });
    expect(after).toContain('after: replacement');
    expect(after).not.toContain('before:');
    expect(after).toContain('Saving');
  });
  it('shows multiple queued regions and strips context metadata from instructions', () => {
    const markup = render({
      ...request,
      regions: [region, { ...region, id: 'two', quote: 'text' }],
      requestText: 'Change it Referenced context "hidden"',
    });
    expect(markup).toContain('2 regions queued');
    expect(markup).toContain('Change it');
    expect(markup).not.toContain('Referenced context');
    expect(markup).toContain('“text”');
  });
});
