import { afterEach, describe, expect, it } from 'vitest';

import type { AuthorRegionDraft } from '../../src/web/lib/authorViewportTypes';
import { authorCaptureContext, createAuthorCapturePacket } from '../../src/web/stores/authorCapture';
import { authorProfilesForDocument } from '../../src/web/stores/authorProfiles';
import { recordAuthorCaptureStatus, recordAuthorComposerSubmission } from '../../src/web/stores/authorRequestLifecycle';
import {
  addAuthorRegion,
  authorDocument,
  authorSessionWorkspace,
  authorWorkspace,
  completeAuthorSave,
  focusAuthorDocument,
  putAuthorDocument,
  putAuthorRequest,
  reviseAuthorDocument,
  updateAuthorRequest,
} from '../../src/web/stores/authorWorkspaceStore';

afterEach(() => authorWorkspace.reset());

describe('Author request lifecycle', () => {
  it('records correlated Author captures once, consumes drafts, and mutates from the request snapshot', async () => {
    const document = putAuthorDocument('s1', {
      path: 'notes.md',
      kind: 'markdown',
      content: 'hello',
      sourceSha256: 'sha',
    });
    focusAuthorDocument('s1', document.path, document.version, document.sourceSha256);
    const region: AuthorRegionDraft = {
      id: 'r1',
      documentPath: document.path,
      revision: document.version,
      sourceSha256: document.sourceSha256,
      comment: 'rewrite',
      quote: 'hello',
      anchor: { kind: 'text-range', startOffset: 0, endOffset: 5, startLine: 1, endLine: 1 },
      viewport: { width: 800, height: 600 },
      createdAt: 1,
    };
    addAuthorRegion('s1', region);
    const context = authorCaptureContext(createAuthorCapturePacket('capture-1', 2, document, [region]));
    const submission = {
      sessionId: 's1',
      message: 'rewrite this exactly',
      delivery: 'submit' as const,
      submittedAt: 3,
      contextItems: [context],
    };

    recordAuthorComposerSubmission(submission);
    recordAuthorComposerSubmission(submission);
    recordAuthorComposerSubmission({ ...submission, contextItems: [{ ...context, source: 'other' }] });

    expect(authorSessionWorkspace('s1').regions).toEqual([]);
    expect(authorSessionWorkspace('s1').requests).toHaveLength(1);
    expect(authorSessionWorkspace('s1').requests[0]).toMatchObject({
      captureId: 'capture-1',
      requestText: 'rewrite this exactly',
      status: 'REQUESTED',
      regions: [{ id: 'r1', comment: 'rewrite' }],
    });

    const mutate = authorProfilesForDocument('s1', 'notes.md', 'markdown')
      .flatMap((profile) => profile.tools)
      .find((tool) => tool.name === 'author_apply_region')!;
    await expect(
      mutate.execute(
        { regionId: 'r1', expectedRevision: 0, expectedSourceSha256: 'sha', replacement: 'updated' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ changed: true, before: 'hello', after: 'updated', revision: 1 });
    expect(authorDocument('s1', 'notes.md')?.content).toBe('updated');
    expect(authorSessionWorkspace('s1').requests[0]).toMatchObject({ status: 'CHANGED', revision: 1 });
  });

  it('keeps a multi-region request active and rebases untouched text anchors', async () => {
    const document = putAuthorDocument('s1', {
      path: 'notes.md',
      kind: 'markdown',
      content: 'hello world',
      sourceSha256: 'sha',
    });
    focusAuthorDocument('s1', document.path, document.version, document.sourceSha256);
    const regions: AuthorRegionDraft[] = [
      {
        id: 'first',
        documentPath: document.path,
        revision: 0,
        sourceSha256: 'sha',
        comment: 'shorten greeting',
        quote: 'hello',
        anchor: { kind: 'text-range', startOffset: 0, endOffset: 5, startLine: 1, endLine: 1 },
        viewport: { width: 800, height: 600 },
        createdAt: 1,
      },
      {
        id: 'second',
        documentPath: document.path,
        revision: 0,
        sourceSha256: 'sha',
        comment: 'change noun',
        quote: 'world',
        anchor: { kind: 'text-range', startOffset: 6, endOffset: 11, startLine: 1, endLine: 1 },
        viewport: { width: 800, height: 600 },
        createdAt: 1,
      },
    ];
    regions.forEach((region) => addAuthorRegion('s1', region));
    const context = authorCaptureContext(createAuthorCapturePacket('capture-2', 2, document, regions));
    recordAuthorComposerSubmission({
      sessionId: 's1',
      message: 'apply both edits',
      delivery: 'submit',
      submittedAt: 3,
      contextItems: [context],
    });
    const mutate = authorProfilesForDocument('s1', 'notes.md', 'markdown')
      .flatMap((profile) => profile.tools)
      .find((tool) => tool.name === 'author_apply_region')!;

    await mutate.execute(
      { regionId: 'first', expectedRevision: 0, expectedSourceSha256: 'sha', replacement: 'hi' },
      new AbortController().signal,
    );
    expect(authorSessionWorkspace('s1').requests[0]).toMatchObject({
      status: 'REQUESTED',
      revision: 1,
      pendingRegions: [{ id: 'second', revision: 1, anchor: { startOffset: 3, endOffset: 8 } }],
    });
    reviseAuthorDocument('s1', 'notes.md', 'hi world');
    expect(authorDocument('s1', 'notes.md')?.version).toBe(1);
    await mutate.execute(
      { regionId: 'second', expectedRevision: 1, expectedSourceSha256: 'sha', replacement: 'earth' },
      new AbortController().signal,
    );
    expect(authorDocument('s1', 'notes.md')?.content).toBe('hi earth');
    expect(authorSessionWorkspace('s1').requests[0]).toMatchObject({
      status: 'CHANGED',
      revision: 2,
      pendingRegions: [],
    });
  });
  it('completes a changed request only after its matching version saves', () => {
    putAuthorDocument('s1', { path: 'notes.md', kind: 'markdown', content: 'hello', sourceSha256: 'old' });
    focusAuthorDocument('s1', 'notes.md', 0, 'old');
    const region: AuthorRegionDraft = {
      id: 'r1',
      documentPath: 'notes.md',
      revision: 0,
      sourceSha256: 'old',
      comment: 'rewrite',
      anchor: { kind: 'text-range', startOffset: 0, endOffset: 5, startLine: 1, endLine: 1 },
      viewport: { width: 1, height: 1 },
      createdAt: 1,
    };
    const request = {
      id: 'request-1',
      documentPath: 'notes.md',
      requestText: 'rewrite',
      regions: [region],
      status: 'REQUESTED' as const,
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
      sourceSha256: 'old',
    };
    putAuthorRequest('s1', request);
    updateAuthorRequest('s1', 'request-1', (current) => ({ ...current, status: 'CHANGED', revision: 1 }));

    completeAuthorSave('s1', 'notes.md', 'new', 0, undefined);
    expect(authorSessionWorkspace('s1').requests[0]?.status).toBe('CHANGED');
    completeAuthorSave('s1', 'notes.md', 'new', 1, undefined);
    expect(authorSessionWorkspace('s1').requests[0]?.status).toBe('COMPLETE');
    expect(authorDocument('s1', 'notes.md')?.sourceSha256).toBe('new');
  });
  it('settles only the correlated capture and ignores stale events after completion', () => {
    const region: AuthorRegionDraft = {
      id: 'r1',
      documentPath: 'clip.mp4',
      revision: 0,
      comment: 'inspect',
      anchor: { kind: 'video-time-rect', timeSeconds: 1, rect: { x: 0, y: 0, width: 1, height: 1 } },
      viewport: { width: 100, height: 100 },
      createdAt: 1,
    };
    putAuthorRequest('s1', {
      id: 'request',
      captureId: 'capture',
      documentPath: 'clip.mp4',
      requestText: 'inspect',
      regions: [region],
      pendingRegions: [region],
      status: 'REQUESTED',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    recordAuthorCaptureStatus({ sessionId: 'other', captureId: 'capture', status: 'completed' });
    recordAuthorCaptureStatus({ sessionId: 's1', captureId: 'other', status: 'completed' });
    recordAuthorCaptureStatus({ sessionId: 's1', captureId: 'capture', status: 'queued' });
    expect(authorSessionWorkspace('s1').requests[0]?.status).toBe('REQUESTED');
    recordAuthorCaptureStatus({ sessionId: 's1', captureId: 'capture', status: 'working' });
    expect(authorSessionWorkspace('s1').requests[0]?.status).toBe('CHANGING');
    recordAuthorCaptureStatus({ sessionId: 's1', captureId: 'capture', status: 'completed' });
    expect(authorSessionWorkspace('s1').requests[0]).toMatchObject({ status: 'COMPLETE', pendingRegions: [] });
    recordAuthorCaptureStatus({ sessionId: 's1', captureId: 'capture', status: 'working' });
    recordAuthorCaptureStatus({ sessionId: 's1', captureId: 'capture', status: 'error', error: 'late error' });
    expect(authorSessionWorkspace('s1').requests[0]?.status).toBe('COMPLETE');
  });

  it.each([undefined, 'Connection lost'])(
    'records execution failure without claiming the video was saved (%s)',
    (error) => {
      const region: AuthorRegionDraft = {
        id: 'r',
        documentPath: 'clip.mp4',
        revision: 0,
        comment: 'inspect',
        anchor: { kind: 'video-time-rect', timeSeconds: 1, rect: { x: 0, y: 0, width: 1, height: 1 } },
        viewport: { width: 100, height: 100 },
        createdAt: 1,
      };
      putAuthorRequest('s1', {
        id: 'request',
        captureId: 'capture',
        documentPath: 'clip.mp4',
        requestText: 'inspect',
        regions: [region],
        status: 'REQUESTED',
        revision: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      recordAuthorCaptureStatus({ sessionId: 's1', captureId: 'capture', status: 'error', error });
      expect(authorSessionWorkspace('s1').requests[0]).toMatchObject({
        status: 'FAILED',
        error: error || 'Request execution failed.',
      });
    },
  );
});
