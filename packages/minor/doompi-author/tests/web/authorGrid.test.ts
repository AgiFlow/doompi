import { afterEach, describe, expect, it } from 'vitest';
import { autonomousVoiceGridVisible } from '../../src/web/AuthorGridOverlay.tsx';
import {
  authorGrid,
  clearAuthorGridGeometry,
  parseAuthorGridCell,
  registerAuthorGridResolver,
  resolveAuthorGridCell,
  updateAuthorGridGeometry,
} from '../../src/web/authorGrid.ts';
import { authorProfilesForDocument } from '../../src/web/authorProfiles.ts';
import {
  authorDocument,
  authorSessionWorkspace,
  authorWorkspace,
  focusAuthorDocument,
  putAuthorDocument,
} from '../../src/web/authorWorkspaceStore.ts';

afterEach(() => {
  authorGrid.reset();
  authorWorkspace.reset();
});

describe('Author Voice coordinate grid', () => {
  it('parses A1 through H8 and resolves normalized cells against one geometry token', () => {
    expect(parseAuthorGridCell(' h8 ')).toEqual({ cell: 'H8', column: 7, row: 7 });
    expect(() => parseAuthorGridCell('I1')).toThrow('A1 through H8');
    const geometry = updateAuthorGridGeometry('s1', {
      documentPath: 'notes.md',
      revision: 2,
      sourceSha256: 'sha',
      viewport: { width: 800, height: 640 },
    });
    expect(resolveAuthorGridCell('s1', 'A1', geometry.geometryToken)).toMatchObject({
      rect: { x: 0, y: 0, width: 0.125, height: 0.125 },
      center: { x: 0.0625, y: 0.0625 },
    });
    const next = updateAuthorGridGeometry('s1', {
      documentPath: 'notes.md',
      revision: 2,
      sourceSha256: 'sha',
      viewport: { width: 801, height: 640 },
    });
    expect(next.geometryToken).not.toBe(geometry.geometryToken);
    expect(next.snapshotId).toBe(geometry.snapshotId);
    expect(() => resolveAuthorGridCell('s1', 'A1', geometry.geometryToken)).toThrow('STALE_GRID');
    clearAuthorGridGeometry('s1');
    expect(() => resolveAuthorGridCell('s1', 'A1', next.geometryToken)).toThrow('STALE_GRID');
  });

  it('shows only for an explicitly published autonomous Voice status', () => {
    expect(autonomousVoiceGridVisible({ 'doom-voice': 'voice auto: listening' })).toBe(true);
    expect(autonomousVoiceGridVisible({ 'doom-voice': 'voice manual: listening' })).toBe(false);
    expect(autonomousVoiceGridVisible({})).toBe(false);
  });

  it('does not publish unfenced legacy mutation tools', () => {
    const names = (kind: 'markdown' | 'image' | 'csv') =>
      authorProfilesForDocument('s1', `document.${kind}`, kind)
        .flatMap((profile) => profile.tools)
        .map((tool) => tool.name);
    expect(names('markdown')).not.toContain('author_replace_text');
    expect(names('image')).not.toContain('author_set_crop');
    expect(names('csv')).not.toContain('author_replace_fragment');
  });

  it('resolves a cell to a native anchor before a fenced text mutation', async () => {
    const releaseResolver = registerAuthorGridResolver('s1', () => ({
      anchor: { kind: 'text-range', startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
      quote: 'a',
    }));
    putAuthorDocument('s1', { path: 'notes.md', kind: 'markdown', content: 'alpha\nbeta', sourceSha256: 'sha' });
    focusAuthorDocument('s1', 'notes.md', 0, 'sha');
    const geometry = updateAuthorGridGeometry('s1', {
      documentPath: 'notes.md',
      revision: 0,
      sourceSha256: 'sha',
      viewport: { width: 800, height: 640 },
    });
    const tools = authorProfilesForDocument('s1', 'notes.md', 'markdown').flatMap((profile) => profile.tools);
    const describe = tools.find((tool) => tool.name === 'author_describe_grid')!;
    const resolve = tools.find((tool) => tool.name === 'author_resolve_grid_cell')!;
    const mutate = tools.find((tool) => tool.name === 'author_apply_region')!;

    await expect(describe.execute({}, new AbortController().signal)).resolves.toMatchObject({
      geometryToken: geometry.geometryToken,
    });
    const resolved = (await resolve.execute(
      { cell: 'A1', geometryToken: geometry.geometryToken, instruction: 'capitalize this' },
      new AbortController().signal,
    )) as { regionId: string };
    expect(authorSessionWorkspace('s1').regions[0]).toMatchObject({
      id: resolved.regionId,
      comment: 'capitalize this',
      voiceGrid: { cell: 'A1', geometryToken: geometry.geometryToken },
      anchor: { kind: 'text-range' },
    });
    await expect(
      mutate.execute(
        { regionId: resolved.regionId, expectedRevision: 0, expectedSourceSha256: 'sha', replacement: 'A' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ changed: true, after: 'A', revision: 1 });
    expect(authorDocument('s1', 'notes.md')?.content).toBe('Alpha\nbeta');
    expect(authorSessionWorkspace('s1').regions).toEqual([]);
    expect(authorSessionWorkspace('s1').requests[0]).toMatchObject({
      id: `voice:${resolved.regionId}`,
      status: 'CHANGED',
      requestText: 'capitalize this',
      before: 'a',
      after: 'A',
      revision: 1,
    });
    releaseResolver();
  });

  it('records explicit cancellation and stale mutation failures', async () => {
    const releaseResolver = registerAuthorGridResolver('s1', () => ({
      anchor: { kind: 'text-range', startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
      quote: 'a',
    }));
    putAuthorDocument('s1', { path: 'notes.md', kind: 'markdown', content: 'alpha', sourceSha256: 'sha' });
    focusAuthorDocument('s1', 'notes.md', 0, 'sha');
    const geometry = updateAuthorGridGeometry('s1', {
      documentPath: 'notes.md',
      revision: 0,
      sourceSha256: 'sha',
      viewport: { width: 800, height: 640 },
    });
    const tools = authorProfilesForDocument('s1', 'notes.md', 'markdown').flatMap((profile) => profile.tools);
    const resolve = tools.find((tool) => tool.name === 'author_resolve_grid_cell')!;
    const mutate = tools.find((tool) => tool.name === 'author_apply_region')!;
    const cancelled = (await resolve.execute(
      { cell: 'A1', geometryToken: geometry.geometryToken, instruction: 'cancel this' },
      new AbortController().signal,
    )) as { regionId: string };
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      mutate.execute(
        { regionId: cancelled.regionId, expectedRevision: 0, expectedSourceSha256: 'sha', replacement: 'A' },
        controller.signal,
      ),
    ).rejects.toThrow('stop');
    expect(authorDocument('s1', 'notes.md')?.content).toBe('alpha');
    expect(authorSessionWorkspace('s1').requests[0]).toMatchObject({ status: 'CANCELLED' });

    const failed = (await resolve.execute(
      { cell: 'B1', geometryToken: geometry.geometryToken, instruction: 'fail this' },
      new AbortController().signal,
    )) as { regionId: string };
    await expect(
      mutate.execute(
        { regionId: failed.regionId, expectedRevision: 1, expectedSourceSha256: 'sha', replacement: 'A' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('STALE_DOCUMENT');
    expect(authorSessionWorkspace('s1').requests[1]).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('STALE_DOCUMENT'),
    });
    releaseResolver();
  });
  it('rejects stale mutations and capture-only media', async () => {
    putAuthorDocument('s1', { path: 'clip.mp4', kind: 'video', mediaUrl: '/clip.mp4', sourceSha256: 'sha' });
    focusAuthorDocument('s1', 'clip.mp4', 0, 'sha');
    const geometry = updateAuthorGridGeometry('s1', {
      documentPath: 'clip.mp4',
      revision: 0,
      sourceSha256: 'sha',
      viewport: { width: 800, height: 640 },
    });
    const tools = authorProfilesForDocument('s1', 'clip.mp4', 'video').flatMap((profile) => profile.tools);
    expect(tools.some((tool) => tool.name === 'author_apply_region')).toBe(false);
    await expect(
      tools
        .find((tool) => tool.name === 'author_resolve_grid_cell')!
        .execute(
          { cell: 'B2', geometryToken: geometry.geometryToken, instruction: 'change this' },
          new AbortController().signal,
        ),
    ).rejects.toThrow('UNSUPPORTED_GRID');
  });
});
