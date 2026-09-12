import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DoomHubChannelHost } from '@agimon-ai/doompi-core/hub-channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileEditPaths } from '../../../src/services/fileEditPaths';
import { createFilesChannel, readSessionFiles } from '../../../src/controllers/webFilesChannel';

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
  vi.unstubAllEnvs();
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
        line({ version: 2, path: scanned, tool: 'bash', at: 20, origin: 'scan', verified: true }),
      ].join(''),
    );
    expect(readSessionFiles(timelinePath, root)).toEqual([
      { path: edited, relPath: path.join('src', 'a.ts'), tool: 'edit', at: 30, count: 2, diffable: true },
      // Found by scanning, so there is no baseline and the row must say so.
      { path: scanned, relPath: 'b.txt', tool: 'bash', at: 20, count: 1, diffable: false },
    ]);
  });

  it('leaves out a scan the tracker could not confirm, and every version 1 bash line', () => {
    const edited = place('src/a.ts');
    const touched = place('touched.txt');
    const legacy = place('legacy.txt');
    fs.writeFileSync(
      timelinePath,
      [
        line({ version: 2, path: edited, tool: 'edit', at: 10, origin: 'tool', before: 'b' }),
        // A command moved the modification time; nothing proved the bytes moved.
        line({ version: 2, path: touched, tool: 'bash', at: 20, origin: 'scan' }),
        line({ version: 1, path: legacy, tool: 'bash', at: 30 }),
      ].join(''),
    );
    expect(readSessionFiles(timelinePath, root).map((row) => row.relPath)).toEqual([path.join('src', 'a.ts')]);
  });
  it('leaves out a file the session changed and then deleted', () => {
    const kept = place('kept.ts');
    const removed = place('removed.ts');
    fs.writeFileSync(
      timelinePath,
      [
        line({ version: 2, path: kept, tool: 'edit', at: 10, origin: 'tool', before: 'b' }),
        line({ version: 2, path: removed, tool: 'bash', at: 20, origin: 'scan', verified: true }),
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
      line({ version: 2, path: path.join(root, 'a-directory'), tool: 'bash', at: 10, origin: 'scan', verified: true }),
    );
    expect(readSessionFiles(timelinePath, root)).toEqual([]);
  });

  it('filters rows through the project .doomignore while preserving visible metadata and order', () => {
    const kept = place('src/kept.ts');
    const ignored = place('generated.log');
    fs.writeFileSync(
      timelinePath,
      [
        line({ version: 2, path: kept, tool: 'edit', at: 10, origin: 'tool', before: 'before' }),
        line({ version: 2, path: ignored, tool: 'bash', at: 20, origin: 'scan', verified: true }),
      ].join(''),
    );
    fs.writeFileSync(path.join(root, '.doomignore'), '*.log\n');

    expect(readSessionFiles(timelinePath, root)).toEqual([
      { path: kept, relPath: path.join('src', 'kept.ts'), tool: 'edit', at: 10, count: 1, diffable: true },
    ]);
  });

  it('fails open when .doomignore cannot be read', () => {
    const kept = place('kept.ts');
    fs.writeFileSync(
      timelinePath,
      line({ version: 2, path: kept, tool: 'edit', at: 10, origin: 'tool', before: 'before' }),
    );
    fs.mkdirSync(path.join(root, '.doomignore'));

    expect(readSessionFiles(timelinePath, root).map((row) => row.relPath)).toEqual(['kept.ts']);
  });

  it('answers nothing for a session that has changed nothing yet', () => {
    expect(readSessionFiles(timelinePath, root)).toEqual([]);
  });
});

describe('createFilesChannel', () => {
  function createHost(): DoomHubChannelHost & {
    published: Array<[string, unknown]>;
    emit(sessionId: string, payload: unknown): void;
  } {
    const published: Array<[string, unknown]> = [];
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    return {
      published,
      sessions: () => [],
      directEvents: {
        publish(frameType, sessionId, payload) {
          for (const listener of listeners.get(`${frameType}:${sessionId}`) ?? []) listener(payload);
        },
        subscribe(frameType, sessionId, listener) {
          const key = `${frameType}:${sessionId}`;
          const current = listeners.get(key) ?? new Set<(payload: unknown) => void>();
          current.add(listener);
          listeners.set(key, current);
          return () => {
            current.delete(listener);
            if (current.size === 0) listeners.delete(key);
          };
        },
        close: () => listeners.clear(),
      },
      emit(sessionId, payload) {
        this.directEvents.publish('file_edits', sessionId, payload);
      },
      publish: (sessionId, payload) => published.push([sessionId, payload]),
      requestSessionApi: () => Promise.resolve(Response.json({ error: 'not implemented' }, { status: 501 })),
      onNotice: () => undefined,
    };
  }

  it('seeds durable state and follows direct events until the session leaves', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', root);
    const edited = place('a.ts');
    const sessionId = 's1';
    const actualTimelinePath = new FileEditPaths().timelinePath(root, sessionId);
    fs.writeFileSync(
      actualTimelinePath,
      line({ version: 2, path: edited, tool: 'edit', at: 1, origin: 'tool', before: 'before' }),
    );
    const host = createHost();
    const source = createFilesChannel().start(host);

    source.sessionAdded?.({ sessionId, cwd: root });
    expect(source.payloadFor({ sessionId, cwd: root })).toEqual({
      items: [{ path: edited, relPath: 'a.ts', tool: 'edit', at: 1, count: 1, diffable: true }],
    });

    const direct = { items: [{ path: edited, relPath: 'a.ts', tool: 'write', at: 2, count: 2, diffable: true }] };
    host.emit(sessionId, direct);
    expect(source.payloadFor({ sessionId, cwd: root })).toEqual(direct);
    expect(host.published.at(-1)).toEqual([sessionId, direct]);

    source.sessionRemoved?.(sessionId);
    const count = host.published.length;
    host.emit(sessionId, { items: [] });
    expect(host.published).toHaveLength(count);
    expect(source.payloadFor({ sessionId, cwd: root })).toBeUndefined();
  });

  it('ignores malformed direct payloads and closes every subscription', () => {
    const host = createHost();
    const source = createFilesChannel().start(host);
    source.sessionAdded?.({ sessionId: 's1', cwd: root });
    source.sessionAdded?.({ sessionId: 's2', cwd: root });
    const count = host.published.length;

    host.emit('s1', { items: 'invalid' });
    expect(host.published).toHaveLength(count);
    source.close();
    host.emit('s1', { items: [] });
    host.emit('s2', { items: [] });
    expect(host.published).toHaveLength(count);
  });

  it('sends no frame for a session it has never heard from', () => {
    const source = createFilesChannel().start(createHost());
    expect(source.payloadFor({ sessionId: 'unknown', cwd: root })).toBeUndefined();
  });

  it('claims the frame type the plugin manifest declares', () => {
    expect(createFilesChannel().frameType).toBe('file_edits');
  });
});
