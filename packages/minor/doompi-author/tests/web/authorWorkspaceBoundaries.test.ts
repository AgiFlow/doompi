import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AuthorRegionDraft,
  AuthorRequestRecord,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorViewportTypes';
import * as workspace from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorWorkspaceStore';
const session = 'workspace-boundaries';
const region: AuthorRegionDraft = {
  id: 'r',
  documentPath: 'a.md',
  revision: 0,
  sourceSha256: 'sha',
  comment: 'Edit',
  anchor: { kind: 'text-range', startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
  viewport: { width: 10, height: 10 },
  createdAt: 1,
};
const request: AuthorRequestRecord = {
  id: 'q',
  documentPath: 'a.md',
  revision: 0,
  sourceSha256: 'sha',
  requestText: 'Edit',
  regions: [region],
  status: 'REQUESTED',
  createdAt: 1,
  updatedAt: 1,
};
beforeEach(() => {
  workspace.putAuthorDocument(session, { path: 'a.md', kind: 'markdown', content: 'a', sourceSha256: 'sha' });
  workspace.focusAuthorDocument(session, 'a.md');
});
afterEach(() => {
  workspace.dropAuthorSession(session);
  vi.restoreAllMocks();
});

describe('Author workspace boundary and retention contracts', () => {
  it('validates empty paths, stale candidates, comments, duplicate regions and ownership', () => {
    expect(() => workspace.putAuthorDocument(session, { path: './.', kind: 'text' })).toThrow('empty');
    expect(workspace.authorDocument(null, 'a.md')).toBeUndefined();
    expect(workspace.authorDocumentAnnotations(null, 'a.md').annotations).toEqual([]);
    expect(() => workspace.commitAuthorRegion(session, 'a.md', 'Edit')).toThrow('Select');
    for (const invalid of [
      { ...region, documentPath: 'other' },
      { ...region, revision: 1 },
      { ...region, sourceSha256: 'other' },
    ]) {
      expect(() => workspace.setAuthorRegionCandidate(session, 'a.md', invalid)).toThrow();
      expect(() => workspace.addAuthorRegion(session, invalid)).toThrow();
    }
    expect(() => workspace.setAuthorRegionCandidate('unfocused', 'a.md', region)).toThrow('document');
    expect(() => workspace.addAuthorRegion('unfocused', region)).toThrow('document');
    expect(() => workspace.addAuthorRegion(session, { ...region, comment: ' ' })).toThrow('comment');
    workspace.addAuthorRegion(session, region);
    expect(() => workspace.addAuthorRegion(session, region)).toThrow('already exists');
    expect(() => workspace.updateAuthorRegionComment(session, 'a.md', 'r', '')).toThrow('comment');
    workspace.addAuthorRegion(session, { ...region, id: 'other' });
    workspace.updateAuthorRegionComment(session, 'a.md', 'r', 'Updated');
    expect(workspace.authorDocumentAnnotations(session, 'a.md').annotations.map((r) => r.comment)).toEqual([
      'Updated',
      'Edit',
    ]);
    workspace.removeAuthorRegion(session, 'a.md', 'missing');
    expect(workspace.authorDocumentAnnotations(session, 'a.md').annotations).toHaveLength(2);
  });
  it('copies candidate anchors, commits once, and releases only obsolete blob thumbnails', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const candidate = { ...region, viewport: { ...region.viewport }, thumbnailUrl: 'blob:first' };
    workspace.setAuthorRegionCandidate(session, 'a.md', candidate);
    candidate.viewport.width = 30;
    expect(workspace.authorDocumentAnnotations(session, 'a.md').candidate?.viewport.width).toBe(10);
    workspace.setAuthorRegionCandidate(session, 'a.md', { ...region, thumbnailUrl: 'blob:first' });
    expect(revoke).not.toHaveBeenCalled();
    workspace.setAuthorRegionCandidate(session, 'a.md', { ...region, thumbnailUrl: 'blob:second' });
    expect(revoke).toHaveBeenCalledWith('blob:first');
    const id = workspace.commitAuthorRegion(session, 'a.md', 'Committed');
    expect(workspace.authorDocumentAnnotations(session, 'a.md').candidate).toBeUndefined();
    expect(workspace.authorDocumentAnnotations(session, 'a.md').annotations[0]).toMatchObject({
      id,
      comment: 'Committed',
    });
    workspace.removeAuthorRegion(session, 'a.md', id);
    expect(revoke).toHaveBeenCalledWith('blob:second');
    workspace.setAuthorRegionCandidate(session, 'a.md', { ...region, thumbnailUrl: 'https://image' });
    workspace.setAuthorRegionCandidate(session, 'a.md', undefined);
    expect(revoke).toHaveBeenCalledTimes(2);
  });
  it('preserves thumbnails on refocus and cleans them on revision changes even if revocation fails', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      throw new Error('already revoked');
    });
    workspace.setAuthorRegionCandidate(session, 'a.md', { ...region, thumbnailUrl: 'blob:candidate' });
    workspace.addAuthorRegion(session, { ...region, thumbnailUrl: 'blob:region' });
    workspace.focusAuthorDocument(session, 'other.md');
    expect(revoke).not.toHaveBeenCalled();
    expect(workspace.authorDocumentAnnotations(session, 'a.md')?.annotations).toHaveLength(1);
    const generation = workspace.focusAuthorDocument(session, 'a.md');
    workspace.releaseAuthorDocumentFocus(session, generation + 1);
    expect(workspace.authorSessionWorkspace(session).focusedDocument?.generation).toBe(generation);
    workspace.releaseAuthorDocumentFocus(session, generation);
    expect(workspace.authorSessionWorkspace(session).focusedDocument).toBeUndefined();
    workspace.focusAuthorDocument(session, 'a.md');
    workspace.setAuthorRegionCandidate(session, 'a.md', { ...region, thumbnailUrl: 'blob:candidate' });
    workspace.addAuthorRegion(session, { ...region, id: 'r2', thumbnailUrl: 'blob:region-2' });
    workspace.reviseAuthorDocument(session, 'a.md', 'b');
    expect(workspace.authorDocumentAnnotations(session, 'a.md').annotations).toEqual([]);
    expect(revoke).toHaveBeenCalledTimes(3);
  });
  it('invalidates a hidden document without clearing the currently visible canvas', () => {
    workspace.addAuthorRegion(session, region);
    workspace.putAuthorDocument(session, { path: 'b.md', kind: 'markdown', content: 'b', sourceSha256: 'second' });
    workspace.focusAuthorDocument(session, 'b.md');
    expect(workspace.authorDocumentAnnotations(session, 'a.md')?.stale).toBe(false);
    workspace.reviseAuthorDocument(session, 'a.md', 'changed');
    expect(workspace.authorSessionWorkspace(session).annotationsByDocument['a.md']?.stale).toBe(true);
    expect(workspace.authorDocumentAnnotations(session, 'a.md').annotations).toEqual([]);
    expect(workspace.authorSessionWorkspace(session).focusedDocument?.path).toBe('b.md');
    expect(workspace.authorDocumentAnnotations(session, 'a.md').annotations).toEqual([]);
  });
  it('deep-copies stroke feedback through candidate and request snapshots', () => {
    const stroke = [
      { x: 0.1, y: 0.2 },
      { x: 0.3, y: 0.4 },
    ];
    workspace.setAuthorRegionCandidate(session, 'a.md', { ...region, stroke });
    stroke[0]!.x = 0.9;
    expect(workspace.authorDocumentAnnotations(session, 'a.md').candidate?.stroke?.[0]?.x).toBe(0.1);
    workspace.commitAuthorRegion(session, 'a.md', 'Mark here');
    const stored = workspace.authorDocumentAnnotations(session, 'a.md').annotations[0]!;
    workspace.putAuthorRequest(session, { ...request, regions: [stored] });
    expect(workspace.authorSessionWorkspace(session).requests[0]?.regions[0]?.stroke).toEqual([
      { x: 0.1, y: 0.2 },
      { x: 0.3, y: 0.4 },
    ]);
  });
  it('treats missing documents, unchanged text and fragment edits as no-ops', () => {
    workspace.reviseAuthorDocument(session, 'missing', 'b');
    workspace.reviseAuthorDocument(session, 'a.md', 'a');
    workspace.reviseAuthorFragment(session, 'a.md', 'missing', 'b');
    expect(workspace.authorDocument(session, 'a.md')?.version).toBe(0);
    const fragments = [
      { id: 'a', text: 'one', kind: 'cell' as const, location: 'A1' },
      { id: 'b', text: 'two', kind: 'cell' as const, location: 'B1' },
    ];
    workspace.putAuthorDocument(session, { path: 'a.csv', kind: 'csv', fragments });
    workspace.reviseAuthorFragment(session, 'a.csv', 'a', 'one');
    workspace.reviseAuthorFragment(session, 'a.csv', 'a', 'updated');
    expect(workspace.authorDocument(session, 'a.csv')).toMatchObject({
      version: 1,
      fragments: [
        { id: 'a', text: 'updated' },
        { id: 'b', text: 'two' },
      ],
    });
    workspace.setAuthorCrop(session, 'a.csv', { x: 0, y: 0, width: 1, height: 1 });
    workspace.setAuthorCrop(session, 'a.csv', undefined);
    expect(workspace.authorDocument(session, 'a.csv')?.crop).toBeUndefined();
    workspace.setAuthorToolMode(session, 'a.md', 'select');
    workspace.setAuthorToolMode(session, 'a.md', 'crop');
    expect(workspace.authorToolMode(session, 'a.md')).toBe('crop');
  });
  it('rejects invalid requests and protects active requests when history is full', () => {
    for (const invalid of [
      { ...request, requestText: '' },
      { ...request, regions: [] },
      { ...request, regions: [{ ...region, comment: '' }] },
    ])
      expect(() => workspace.putAuthorRequest(session, invalid)).toThrow();
    workspace.putAuthorRequest(session, request);
    expect(() => workspace.putAuthorRequest(session, request)).toThrow('already exists');
    for (let i = 1; i < workspace.AUTHOR_HISTORY_RECORD_LIMIT; i++)
      workspace.putAuthorRequest(session, { ...request, id: String(i) });
    expect(() => workspace.putAuthorRequest(session, { ...request, id: 'overflow' })).toThrow('active requests');
    expect(workspace.authorSessionWorkspace(session).requests).toHaveLength(100);
    workspace.updateAuthorRequest(session, 'q', (r) => ({ ...r, status: 'COMPLETE' }));
    workspace.putAuthorRequest(session, { ...request, id: 'replacement' });
    expect(workspace.authorSessionWorkspace(session).requests.some((r) => r.id === 'q')).toBe(false);
    expect(workspace.authorSessionWorkspace(session).requests.at(-1)?.id).toBe('replacement');
  });
  it('bounds large before/after text and byte-heavy history while retaining active records', () => {
    workspace.putAuthorRequest(session, { ...request, before: '漢'.repeat(8000), after: 'x'.repeat(20000) });
    const copied = workspace.authorSessionWorkspace(session).requests[0]!;
    expect(new TextEncoder().encode(copied.before).length).toBeLessThanOrEqual(16 * 1024);
    expect(copied.before).not.toBe('');
    expect(copied.after).toHaveLength(16160);
    for (let i = 0; i < 20; i++)
      workspace.putAuthorRequest(session, {
        ...request,
        id: `terminal-${i}`,
        status: 'FAILED',
        before: 'x'.repeat(16000),
        after: 'x'.repeat(16000),
      });
    const retained = workspace.authorSessionWorkspace(session).requests;
    expect(new TextEncoder().encode(JSON.stringify(retained)).length).toBeLessThanOrEqual(
      workspace.AUTHOR_HISTORY_BYTE_LIMIT,
    );
    expect(retained[0]?.id).toBe('q');
    expect(retained.length).toBeLessThan(21);
  });
  it('does not let an older save overwrite newer persisted content', () => {
    workspace.reviseAuthorDocument(session, 'a.md', 'b');
    workspace.requestAuthorSave(session, 'a.md');
    workspace.failAuthorSave(session, 'a.md', 0);
    expect(workspace.authorDocument(session, 'a.md')?.savingVersion).toBe(1);
    workspace.completeAuthorSave(session, 'a.md', 'new', 1, []);
    workspace.completeAuthorSave(session, 'a.md', 'old', 0, []);
    expect(workspace.authorDocument(session, 'a.md')).toMatchObject({
      sourceSha256: 'new',
      savedVersion: 1,
      originalFragments: [],
    });
  });
});
