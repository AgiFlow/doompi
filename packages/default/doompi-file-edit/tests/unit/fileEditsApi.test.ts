import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSnapshotStoreAdapter } from '../../src/adapters/node/snapshotStore.ts';
import { TimelineStore } from '../../src/adapters/TimelineStore/TimelineStore.ts';
import { createFileEditsApi } from '../../src/adapters/fileEditsApi.ts';
import type { FileEditsDetailView, FileEditsErrorView, FileEditsPreviewView } from '../../src/types/fileEditsApi.ts';
import { contentUrl, deleteUrl, detailUrl, previewUrl } from '../../src/types/fileEditsApi.ts';

let cwd: string;
let timeline: TimelineStore;
let snapshots: NodeSnapshotStoreAdapter;
let app: ReturnType<typeof createFileEditsApi>;

/** The URL builders carry the mount prefix, which the host strips before the app sees it. */
function mounted(url: string): string {
  return `http://host${url.replace('/api/plugin/file-edits', '')}`;
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-api-'));
  timeline = new TimelineStore();
  timeline.initialize(path.join(cwd, 'timeline.jsonl'));
  snapshots = new NodeSnapshotStoreAdapter();
  snapshots.initialize(path.join(cwd, 'blobs'));
  app = createFileEditsApi({ sessionId: 's1', cwd, timeline, snapshots });
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

/** Records one tool change with both sides captured, the way the tracker would. */
async function recordEdit(relative: string, before: string, after: string, at: number): Promise<string> {
  const filePath = path.join(cwd, relative);
  const beforeHash = await snapshots.put(before);
  fs.writeFileSync(filePath, after);
  const afterHash = await snapshots.put(after);
  await timeline.append({
    version: 2,
    path: filePath,
    tool: 'edit',
    at,
    origin: 'tool',
    before: beforeHash,
    after: afterHash,
  });
  return filePath;
}

describe('the file-edits session API', () => {
  it('answers one file’s history, each change with its own diff', async () => {
    const filePath = await recordEdit('app.ts', 'one\n', 'one\ntwo\n', 10);
    await recordEdit('app.ts', 'one\ntwo\n', 'one\ntwo\nthree\n', 20);

    const response = await app.fetch(new Request(mounted(detailUrl('s1', filePath))));
    expect(response.status).toBe(200);
    const body = (await response.json()) as FileEditsDetailView;
    expect(body.relPath).toBe('app.ts');
    expect(body.versions.map((version) => version.index)).toEqual([1, 2]);
    // Each version shows what that one change did, not the whole file's story.
    expect(body.versions[0]?.additions).toBe(1);
    expect(body.versions[1]?.additions).toBe(1);
    // The cumulative view runs from the oldest baseline to what is on disk now.
    expect(body.cumulative.additions).toBe(2);
    expect(body.working.content).toBe('one\ntwo\nthree\n');
    expect(body.working.unavailable).toBe(false);
  });

  it('says why a change found by scanning has no diff', async () => {
    const filePath = path.join(cwd, 'scripted.txt');
    fs.writeFileSync(filePath, 'written by a script');
    await timeline.append({
      version: 2,
      path: filePath,
      tool: 'bash',
      at: 10,
      origin: 'scan',
      after: await snapshots.put('written by a script'),
    });

    const body = (await (
      await app.fetch(new Request(mounted(detailUrl('s1', filePath))))
    ).json()) as FileEditsDetailView;
    expect(body.versions[0]?.hunks).toBeUndefined();
    expect(body.versions[0]?.note).toContain('no baseline');
    expect(body.cumulative.hunks).toBeUndefined();
    // The file is still readable and editable, which is the point of listing it.
    expect(body.working.content).toBe('written by a script');
  });

  it('reports a file the session deleted rather than pretending it is empty', async () => {
    const filePath = await recordEdit('gone.ts', 'content\n', 'content\n', 10);
    fs.rmSync(filePath);
    const body = (await (
      await app.fetch(new Request(mounted(detailUrl('s1', filePath))))
    ).json()) as FileEditsDetailView;
    expect(body.working.unavailable).toBe(true);
    expect(body.working.reason).toContain('no longer exists');
  });

  it('refuses a file this session never changed', async () => {
    fs.writeFileSync(path.join(cwd, 'secret.env'), 'TOKEN=1');
    const response = await app.fetch(new Request(mounted(detailUrl('s1', path.join(cwd, 'secret.env')))));
    expect(response.status).toBe(404);
  });

  it('refuses a path that climbs out of the session, because the timeline never held it', async () => {
    const response = await app.fetch(new Request(mounted(detailUrl('s1', '../../etc/passwd'))));
    expect(response.status).toBe(404);
  });

  it('previews a file the session never changed, read only', async () => {
    const filePath = path.join(cwd, 'untouched.ts');
    fs.writeFileSync(filePath, 'export const x = 1;\n');
    const response = await app.fetch(new Request(mounted(previewUrl('s1', filePath))));
    expect(response.status).toBe(200);
    const body = (await response.json()) as FileEditsPreviewView;
    expect(body.relPath).toBe('untouched.ts');
    expect(body.working.content).toBe('export const x = 1;\n');
    expect(body.working.unavailable).toBe(false);
  });

  it('refuses a preview that climbs out of the working directory', async () => {
    const escaping = await app.fetch(new Request(mounted(previewUrl('s1', path.join(cwd, '..', 'passwd')))));
    expect(escaping.status).toBe(403);
    const relative = await app.fetch(new Request(mounted(previewUrl('s1', '../../etc/passwd'))));
    expect(relative.status).toBe(403);
  });

  it('refuses a preview through a symlink that points outside', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.env'), 'TOKEN=1');
      fs.symlinkSync(path.join(outside, 'secret.env'), path.join(cwd, 'linked.env'));
      const response = await app.fetch(new Request(mounted(previewUrl('s1', path.join(cwd, 'linked.env')))));
      expect(response.status).toBe(403);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports a preview of a file that is not there rather than refusing', async () => {
    const response = await app.fetch(new Request(mounted(previewUrl('s1', path.join(cwd, 'absent.ts')))));
    expect(response.status).toBe(200);
    const body = (await response.json()) as FileEditsPreviewView;
    expect(body.working.unavailable).toBe(true);
  });

  it('serves no preview at all when the host gave it no working directory', async () => {
    const unbounded = createFileEditsApi({ sessionId: 's1', timeline, snapshots });
    const response = await unbounded.fetch(new Request(mounted(previewUrl('s1', '/etc/passwd'))));
    expect(response.status).toBe(403);
  });

  it('writes a manual save and answers the new hash', async () => {
    const filePath = await recordEdit('app.ts', 'one\n', 'one\ntwo\n', 10);
    const detail = (await (
      await app.fetch(new Request(mounted(detailUrl('s1', filePath))))
    ).json()) as FileEditsDetailView;

    const response = await app.fetch(
      new Request(mounted(contentUrl('s1')), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: filePath, expectedHash: detail.working.hash, content: 'hand written\n' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hand written\n');
  });

  it('refuses a save whose file moved under the editor, and says what it holds now', async () => {
    const filePath = await recordEdit('app.ts', 'one\n', 'one\ntwo\n', 10);
    const detail = (await (
      await app.fetch(new Request(mounted(detailUrl('s1', filePath))))
    ).json()) as FileEditsDetailView;
    // The agent rewrites the file while the reader is still editing it.
    fs.writeFileSync(filePath, 'the agent got there first\n');

    const response = await app.fetch(
      new Request(mounted(contentUrl('s1')), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: filePath, expectedHash: detail.working.hash, content: 'hand written\n' }),
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as FileEditsErrorView;
    expect(body.error).toContain('changed since it was opened');
    expect(body.hash).toBeDefined();
    expect(body.hash).not.toBe(detail.working.hash);
    // The refusal must not have discarded what the agent wrote.
    expect(fs.readFileSync(filePath, 'utf8')).toBe('the agent got there first\n');
  });

  it('refuses a save for a file this session never changed', async () => {
    fs.writeFileSync(path.join(cwd, 'secret.env'), 'TOKEN=1');
    const response = await app.fetch(
      new Request(mounted(contentUrl('s1')), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.join(cwd, 'secret.env'), expectedHash: '', content: 'TOKEN=2' }),
      }),
    );
    expect(response.status).toBe(404);
    expect(fs.readFileSync(path.join(cwd, 'secret.env'), 'utf8')).toBe('TOKEN=1');
  });

  it('deletes a file the session changed', async () => {
    const filePath = await recordEdit('app.ts', 'one\n', 'one\ntwo\n', 10);
    const response = await app.fetch(new Request(mounted(deleteUrl('s1', filePath)), { method: 'DELETE' }));
    expect(response.status).toBe(204);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('treats deleting an already absent file as done rather than failed', async () => {
    const filePath = await recordEdit('app.ts', 'one\n', 'one\n', 10);
    fs.rmSync(filePath);
    const response = await app.fetch(new Request(mounted(deleteUrl('s1', filePath)), { method: 'DELETE' }));
    expect(response.status).toBe(204);
  });

  it('refuses to delete a file this session never changed', async () => {
    const secret = path.join(cwd, 'secret.env');
    fs.writeFileSync(secret, 'TOKEN=1');
    const response = await app.fetch(new Request(mounted(deleteUrl('s1', secret)), { method: 'DELETE' }));
    expect(response.status).toBe(404);
    expect(fs.existsSync(secret)).toBe(true);
  });

  it('says a change predating content capture has no diff, without blaming a command', async () => {
    // A version 1 record: the path and the tool, and nothing else.
    const filePath = path.join(cwd, 'legacy.ts');
    fs.writeFileSync(filePath, 'content');
    fs.writeFileSync(
      path.join(cwd, 'timeline.jsonl'),
      `${JSON.stringify({ version: 1, path: filePath, tool: 'write', at: 5 })}\n`,
    );
    const body = (await (
      await app.fetch(new Request(mounted(detailUrl('s1', filePath))))
    ).json()) as FileEditsDetailView;
    expect(body.versions[0]?.note).toContain('before this session began capturing');
    expect(body.versions[0]?.note).not.toContain('command');
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a body naming no path', JSON.stringify({ expectedHash: '', content: 'x' })],
  ])('refuses %s', async (_name, body) => {
    const response = await app.fetch(
      new Request(mounted(contentUrl('s1')), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(response.status).toBe(400);
  });
});
