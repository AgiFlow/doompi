import { afterEach, describe, expect, it } from 'vitest';
import { authorGridTools } from '../../src/web/authorGridTools.ts';
import { AUTHOR_TEXT_PROFILE, authorProfilesForDocument } from '../../src/web/authorProfiles.ts';
import { authorGrid, registerAuthorGridResolver, updateAuthorGridGeometry } from '../../src/web/authorGrid.ts';
import * as workspace from '../../src/web/authorWorkspaceStore.ts';
import type { AuthorDocumentInput, AuthorNativeAnchor, AuthorRegionDraft } from '../../src/web/authorViewportTypes.ts';
const signal = new AbortController().signal;
const region: AuthorRegionDraft = {
  id: 'r',
  documentPath: 'doc',
  revision: 0,
  sourceSha256: 'sha',
  comment: 'Edit',
  anchor: { kind: 'text-range', startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
  viewport: { width: 100, height: 100 },
  createdAt: 1,
};
function setup(input: Partial<AuthorDocumentInput> = {}, anchor: AuthorNativeAnchor = region.anchor) {
  workspace.putAuthorDocument('s', { path: 'doc', kind: 'text', content: 'abc', sourceSha256: 'sha', ...input });
  workspace.focusAuthorDocument('s', 'doc', 0, 'sha');
  workspace.addAuthorRegion('s', { ...region, anchor });
  workspace.putAuthorRequest('s', {
    id: 'q',
    documentPath: 'doc',
    revision: 0,
    sourceSha256: 'sha',
    regions: [{ ...region, anchor }],
    requestText: 'Edit',
    status: 'REQUESTED',
    createdAt: 1,
    updatedAt: 1,
  });
  return authorGridTools('s', 'doc', input.kind ?? 'text').find((tool) => tool.name === 'author_apply_region')!;
}
const args = { regionId: 'r', expectedRevision: 0, expectedSourceSha256: 'sha', replacement: 'new' };
afterEach(() => {
  workspace.authorWorkspace.reset();
  authorGrid.reset();
});

describe('fenced Author native mutations', () => {
  it.each([null, [], 'invalid', {}])('rejects invalid mutation inputs %j', async (input) => {
    await expect(setup().execute(input, signal)).rejects.toThrow();
    expect(workspace.authorDocument('s', 'doc')?.content).toBe('abc');
  });
  it.each([
    { expectedRevision: 1 },
    { expectedSourceSha256: 'stale' },
    { expectedSourceSha256: '' },
    { regionId: 'missing' },
  ])('rejects stale or missing fences %j', async (update) => {
    await expect(setup().execute({ ...args, ...update }, signal)).rejects.toThrow();
    expect(workspace.authorDocument('s', 'doc')?.version).toBe(0);
  });
  it('refuses edits during saving and marks the request failed', async () => {
    const tool = setup();
    workspace.requestAuthorSave('s', 'doc');
    await expect(tool.execute(args, signal)).rejects.toThrow('SAVE_IN_PROGRESS');
    expect(workspace.authorSessionWorkspace('s').requests[0]).toMatchObject({
      status: 'FAILED',
      currentOperation: undefined,
    });
  });
  it.each([new Error('stop'), undefined])('cancels a request before changing content: %s', async (reason) => {
    const tool = setup();
    const controller = new AbortController();
    controller.abort(reason);
    await expect(tool.execute(args, controller.signal)).rejects.toThrow();
    expect(workspace.authorSessionWorkspace('s').requests[0]).toMatchObject({ status: 'CANCELLED' });
    expect(workspace.authorDocument('s', 'doc')?.content).toBe('abc');
  });
  it('rejects missing documents and regions from stale requests', async () => {
    const tool = setup();
    workspace.dropAuthorSession('s');
    await expect(tool.execute(args, signal)).rejects.toThrow('STALE_DOCUMENT');
    setup();
    workspace.reviseAuthorDocument('s', 'doc', 'abcd');
    await expect(tool.execute({ ...args, expectedRevision: 1 }, signal)).rejects.toThrow('STALE_REGION');
    workspace.updateAuthorRequest('s', 'q', (q) => ({ ...q, regions: [{ ...region, documentPath: 'other' }] }));
    await expect(tool.execute({ ...args, expectedRevision: 1 }, signal)).rejects.toThrow('STALE_REGION');
  });
  it.each(['cell', 'slide-element'] as const)('edits a native %s and records before and after', async (kind) => {
    const anchor: AuthorNativeAnchor =
      kind === 'cell'
        ? { kind, fragmentId: 'f', sheet: 'Sheet1', location: 'A1' }
        : { kind, fragmentId: 'f', slide: 1, elementId: 'e', location: 'slide 1' };
    const tool = setup(
      {
        kind: kind === 'cell' ? 'csv' : 'slides',
        fragments: [{ id: 'f', text: 'old', kind: 'text-run', location: 'A1' }],
      },
      anchor,
    );
    expect(await tool.execute(args, signal)).toMatchObject({ before: 'old', after: 'new', revision: 1 });
    expect(workspace.authorDocument('s', 'doc')?.fragments?.[0]?.text).toBe('new');
    expect(workspace.authorSessionWorkspace('s').requests[0]).toMatchObject({
      status: 'CHANGED',
      before: 'old',
      after: 'new',
      pendingRegions: [],
    });
  });
  it.each([undefined, [{ id: 'f', text: 'old', readOnly: true, kind: 'cell' as const, location: 'A1' }]])(
    'refuses unavailable or read-only native fragments',
    async (fragments) => {
      const tool = setup(
        { kind: 'csv', fragments },
        { kind: 'cell', fragmentId: 'f', sheet: 'Sheet1', location: 'A1' },
      );
      await expect(tool.execute(args, signal)).rejects.toThrow('not editable');
    },
  );
  it('applies an image crop and retains serialized crop evidence', async () => {
    const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const tool = setup({ kind: 'image' }, { kind: 'image-rect', rect, naturalWidth: 100, naturalHeight: 100 });
    expect(await tool.execute(args, signal)).toMatchObject({ crop: rect, revision: 1 });
    expect(workspace.authorDocument('s', 'doc')?.crop).toEqual(rect);
    expect(workspace.authorSessionWorkspace('s').requests[0]?.after).toBe(JSON.stringify(rect));
  });
  it('refuses multi-region crops and capture-only anchors', async () => {
    const tool = setup(
      { kind: 'image' },
      { kind: 'image-rect', rect: { x: 0, y: 0, width: 1, height: 1 }, naturalWidth: 100, naturalHeight: 100 },
    );
    workspace.updateAuthorRequest('s', 'q', (q) => ({ ...q, regions: [...q.regions, { ...region, id: 'other' }] }));
    await expect(tool.execute(args, signal)).rejects.toThrow('multi-region image');
    workspace.authorWorkspace.reset();
    await expect(
      setup({}, { kind: 'pdf-page-rect', page: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }).execute(args, signal),
    ).rejects.toThrow('capture-only');
  });
  it('allows a draft-only mutation and treats missing replacement as deletion', async () => {
    workspace.putAuthorDocument('s', { path: 'doc', kind: 'text', content: 'abc', sourceSha256: 'sha' });
    workspace.focusAuthorDocument('s', 'doc', 0, 'sha');
    workspace.addAuthorRegion('s', region);
    const tool = authorGridTools('s', 'doc', 'text').find((tool) => tool.name === 'author_apply_region')!;
    expect(await tool.execute({ ...args, replacement: undefined }, signal)).toMatchObject({
      before: 'a',
      after: '',
      revision: 1,
    });
    expect(workspace.authorDocument('s', 'doc')?.content).toBe('bc');
  });
  it.each(['pdf', 'video', 'opaque'] as const)(
    'does not offer mutation or resolve capture-only %s coordinates',
    async (kind) => {
      workspace.putAuthorDocument('s', { path: 'doc', kind, sourceSha256: 'sha' });
      workspace.focusAuthorDocument('s', 'doc', 0, 'sha');
      const geometry = updateAuthorGridGeometry('s', {
        documentPath: 'doc',
        revision: 0,
        sourceSha256: 'sha',
        viewport: { width: 100, height: 100 },
      });
      const tools = authorGridTools('s', 'doc', kind);
      expect(tools.map((t) => t.name)).not.toContain('author_apply_region');
      await expect(
        tools[1]!.execute({ cell: 'A1', instruction: 'Edit', geometryToken: geometry.geometryToken }, signal),
      ).rejects.toThrow('UNSUPPORTED_GRID');
    },
  );
  it('rejects unavailable grid descriptions and invalid resolve inputs', async () => {
    const tools = authorGridTools('s', 'doc', 'text');
    await expect(tools[0]!.execute({}, signal)).rejects.toThrow('STALE_GRID');
    for (const input of [
      null,
      [],
      { instruction: '' },
      { instruction: 'Edit', cell: 1 },
      { instruction: 'Edit', cell: 'A1', geometryToken: '' },
    ])
      await expect(tools[1]!.execute(input, signal)).rejects.toThrow();
    updateAuthorGridGeometry('s', { documentPath: 'other', revision: 0, viewport: { width: 1, height: 1 } });
    workspace.putAuthorDocument('s', { path: 'doc', kind: 'text' });
    await expect(tools[0]!.execute({}, signal)).rejects.toThrow('STALE_GRID');
    const geometry = updateAuthorGridGeometry('s', {
      documentPath: 'doc',
      revision: 1,
      viewport: { width: 1, height: 1 },
    });
    await expect(tools[0]!.execute({}, signal)).rejects.toThrow('STALE_GRID');
    const release = registerAuthorGridResolver('s', () => ({ anchor: region.anchor }));
    workspace.dropAuthorSession('s');
    await expect(
      tools[1]!.execute({ instruction: 'Edit', cell: 'A1', geometryToken: geometry.geometryToken }, signal),
    ).rejects.toThrow('STALE_DOCUMENT');
    release();
  });
});

describe('bound review profiles', () => {
  it('binds annotations to the focused target, not caller supplied session and path', async () => {
    workspace.putAuthorDocument('s', { path: 'doc', kind: 'text' });
    const tools = authorProfilesForDocument('s', 'doc', 'text')[0]!.tools;
    await tools[0]!.execute({ body: 'Comment', quote: 'quote', sessionId: 'other', path: 'other' }, signal);
    await tools[0]!.execute({ body: 'Second' }, signal);
    await tools[1]!.execute({ startLine: 1, endLine: 2 }, signal);
    expect(workspace.authorDocument('s', 'doc')?.annotations).toMatchObject([
      { kind: 'comment', body: 'Comment', quote: 'quote' },
      { body: 'Second' },
      { kind: 'highlight', startLine: 1, endLine: 2 },
    ]);
    expect(tools[0]!.inputSchema.required).not.toContain('sessionId');
  });
  it('rejects malformed annotation targets and invalid highlight ranges', async () => {
    const [comment, highlight] = AUTHOR_TEXT_PROFILE.tools;
    for (const input of [null, [], {}, { sessionId: 's' }, { sessionId: 's', path: 'doc', body: 1 }])
      await expect(comment!.execute(input, signal)).rejects.toThrow();
    for (const [startLine, endLine] of [
      [1.5, 2],
      [1, 2.5],
      [0, 2],
      [3, 2],
    ])
      await expect(highlight!.execute({ sessionId: 's', path: 'doc', startLine, endLine }, signal)).rejects.toThrow();
    const bound = authorProfilesForDocument('s', 'doc', 'text')[0]!.tools[0]!;
    await expect(bound.execute(null, signal)).rejects.toThrow('Expected an object');
  });
});
