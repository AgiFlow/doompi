import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HubChannelHost, HubSessionScope } from '@agimon-ai/doompi-web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFilesChannel, readSessionFiles, watchFiles } from '../../../src/adapters/webFilesChannel.ts';
import type { FilesItemView } from '../../../src/types/webFiles.ts';

let root: string;
let timelinePath: string;

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-channel-'));
  timelinePath = path.join(root, 'timeline.jsonl');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

/** A file the timeline names that is actually there, which is what a row requires. */
function place(relative: string): string {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'content');
  return filePath;
}

describe('readSessionFiles', () => {
  it('presents the timeline as rows, newest first, relative to the session', () => {
    const edited = place('src/a.ts');
    const scanned = place('b.txt');
    fs.writeFileSync(
      timelinePath,
      [
        line({ version: 2, path: edited, tool: 'edit', at: 10, origin: 'tool', before: 'b' }),
        line({ version: 2, path: edited, tool: 'edit', at: 30, origin: 'tool', before: 'b' }),
        line({ version: 2, path: scanned, tool: 'bash', at: 20, origin: 'scan' }),
      ].join(''),
    );
    expect(readSessionFiles(timelinePath, root)).toEqual([
      { path: edited, relPath: path.join('src', 'a.ts'), tool: 'edit', at: 30, count: 2, diffable: true },
      // Found by scanning, so there is no baseline and the row must say so.
      { path: scanned, relPath: 'b.txt', tool: 'bash', at: 20, count: 1, diffable: false },
    ]);
  });

  it('leaves out a file the session changed and then deleted', () => {
    const kept = place('kept.ts');
    const removed = place('removed.ts');
    fs.writeFileSync(
      timelinePath,
      [
        line({ version: 2, path: kept, tool: 'edit', at: 10, origin: 'tool', before: 'b' }),
        line({ version: 2, path: removed, tool: 'bash', at: 20, origin: 'scan' }),
      ].join(''),
    );
    fs.rmSync(removed);
    // The dock lists things to open, and a row that can only answer "this is
    // gone" is a dead end.
    expect(readSessionFiles(timelinePath, root).map((row) => row.relPath)).toEqual(['kept.ts']);
  });

  it('leaves out a path the timeline names that is a directory rather than a file', () => {
    fs.mkdirSync(path.join(root, 'a-directory'));
    fs.writeFileSync(
      timelinePath,
      line({ version: 2, path: path.join(root, 'a-directory'), tool: 'bash', at: 10, origin: 'scan' }),
    );
    expect(readSessionFiles(timelinePath, root)).toEqual([]);
  });

  it('answers nothing for a session that has changed nothing yet', () => {
    expect(readSessionFiles(timelinePath, root)).toEqual([]);
  });
});

describe('watchFiles', () => {
  it('reports the current list, then reports again only once it changes', async () => {
    vi.useFakeTimers();
    const seen: FilesItemView[][] = [];
    const scope: HubSessionScope = { sessionId: 's1', cwd: root };
    // The real path resolver keys off the session id, so the test drives the
    // reader directly and uses the watcher only for its polling behaviour.
    const source = watchFiles(scope, (items) => seen.push(items), { pollMs: 10, debounceMs: 1 });
    try {
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual([]);
      await vi.advanceTimersByTimeAsync(30);
      // Nothing changed, so nothing more was announced.
      expect(seen).toHaveLength(1);
    } finally {
      source.close();
    }
  });

  it('stops polling once closed', async () => {
    vi.useFakeTimers();
    const seen: FilesItemView[][] = [];
    const source = watchFiles({ sessionId: 's1', cwd: root }, (items) => seen.push(items), { pollMs: 5 });
    source.close();
    const count = seen.length;
    await vi.advanceTimersByTimeAsync(50);
    expect(seen).toHaveLength(count);
  });
});

describe('createFilesChannel', () => {
  function createHost(): HubChannelHost & { published: Array<[string, unknown]> } {
    const published: Array<[string, unknown]> = [];
    return {
      published,
      sessions: () => [],
      publish: (sessionId, payload) => published.push([sessionId, payload]),
      onNotice: () => undefined,
    };
  }

  it('watches a session when it arrives and stops when it leaves', () => {
    const closed: string[] = [];
    const channel = createFilesChannel((scope, onChange) => {
      onChange([{ path: '/a.ts', relPath: 'a.ts', tool: 'edit', at: 1, count: 1, diffable: true }]);
      return { close: () => closed.push(scope.sessionId) };
    });
    const host = createHost();
    const source = channel.start(host);

    source.sessionAdded?.({ sessionId: 's1', cwd: root });
    expect(host.published).toHaveLength(1);
    expect(source.payloadFor({ sessionId: 's1', cwd: root })).toEqual({
      items: [{ path: '/a.ts', relPath: 'a.ts', tool: 'edit', at: 1, count: 1, diffable: true }],
    });

    source.sessionRemoved?.('s1');
    expect(closed).toEqual(['s1']);
    // A session that left reports nothing rather than its last known list.
    expect(source.payloadFor({ sessionId: 's1', cwd: root })).toBeUndefined();
  });

  it('sends no frame for a session it has never heard from', () => {
    const channel = createFilesChannel(() => ({ close: () => undefined }));
    const source = channel.start(createHost());
    expect(source.payloadFor({ sessionId: 'unknown', cwd: root })).toBeUndefined();
  });

  it('closes every watcher it started', () => {
    const closed: string[] = [];
    const channel = createFilesChannel((scope) => ({ close: () => closed.push(scope.sessionId) }));
    const source = channel.start(createHost());
    source.sessionAdded?.({ sessionId: 's1', cwd: root });
    source.sessionAdded?.({ sessionId: 's2', cwd: root });
    source.close();
    expect(closed.sort()).toEqual(['s1', 's2']);
  });

  it('claims the frame type the plugin manifest declares', () => {
    expect(createFilesChannel().frameType).toBe('file_edits');
  });
});
