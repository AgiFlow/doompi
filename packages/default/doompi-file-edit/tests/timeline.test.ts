import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileEditPaths } from '../src/adapters/FileEditPaths/FileEditPaths.ts';
import { EditTracker } from '../src/adapters/EditTracker/EditTracker.ts';
import { TimelineStore } from '../src/adapters/TimelineStore/TimelineStore.ts';
import { FileEditOverlayComponent } from '../src/tui/fileEditOverlay.ts';

let directory: string;
let store: TimelineStore;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-timeline-'));
  store = new TimelineStore();
  store.initialize(path.join(directory, 'timeline.jsonl'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('TimelineStore', () => {
  it('deduplicates by path, counts repeats, and orders by the latest edit', async () => {
    await store.append({ version: 1, path: '/a.ts', tool: 'edit', at: 10 });
    await store.append({ version: 1, path: '/b.ts', tool: 'write', at: 20 });
    await store.append({ version: 1, path: '/a.ts', tool: 'bash', at: 30 });
    expect(await store.list()).toEqual([
      { path: '/a.ts', tool: 'bash', at: 30, count: 2 },
      { path: '/b.ts', tool: 'write', at: 20, count: 1 },
    ]);
  });

  it('keeps different session files isolated', async () => {
    await store.append({ version: 1, path: '/a.ts', tool: 'edit', at: 10 });
    const other = new TimelineStore();
    other.initialize(path.join(directory, 'other.jsonl'));
    expect(await other.list()).toEqual([]);
  });

  it('records exact edit and write paths only after successful completion', async () => {
    const tracker = new EditTracker(store);
    const filePath = path.join(directory, 'edited.ts');
    fs.writeFileSync(filePath, 'before');
    await tracker.start('edit-1', 'edit', { path: filePath }, directory);
    await tracker.end('edit-1', false);
    await tracker.start('write-1', 'write', { path: 'created.ts' }, directory);
    await tracker.end('write-1', false);
    await tracker.start('failed', 'edit', { path: filePath }, directory);
    await tracker.end('failed', true);
    expect((await store.list()).map((entry) => [entry.path, entry.tool])).toEqual(
      expect.arrayContaining([
        [path.join(directory, 'created.ts'), 'write'],
        [filePath, 'edit'],
      ]),
    );
  });

  it('attributes bash only to literal candidates whose fingerprints changed', async () => {
    const tracker = new EditTracker(store);
    const changed = path.join(directory, 'changed.txt');
    const untouched = path.join(directory, 'untouched.txt');
    fs.writeFileSync(changed, 'before');
    fs.writeFileSync(untouched, 'same');
    await tracker.start('bash-1', 'bash', { command: `printf after > ${changed}; cat ${untouched}` }, directory);
    fs.writeFileSync(changed, 'after value');
    await tracker.end('bash-1', false);
    expect((await store.list()).map((entry) => entry.path)).toEqual([changed]);
  });

  it('ignores an overlong path candidate extracted from inline Python source', async () => {
    const tracker = new EditTracker(store);
    const inlineSource = `${'x'.repeat(300)}/generation-request.json`;
    await expect(
      tracker.start('bash-python', 'bash', { command: `python3 -c "${inlineSource}"` }, directory),
    ).resolves.toBeUndefined();
    await expect(tracker.end('bash-python', false)).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('clears the root timeline and tolerates one malformed JSONL record', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.append({ version: 1, path: '/a.ts', tool: 'edit', at: 10 });
    fs.appendFileSync(path.join(directory, 'timeline.jsonl'), '{invalid}\n');
    expect(await store.list()).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    await store.clear();
    expect(await store.list()).toEqual([]);
    warn.mockRestore();
  });

  it.each([
    {
      name: 'reuses the parent key for a child with a parent id',
      sessionId: 'child-session',
      env: { [SUBAGENT_CHILD_ENV]: '1', [SUBAGENT_PARENT_SESSION_ENV]: 'root-session' },
      expected: 'root-session',
    },
    {
      name: 'keeps the child key when the parent id is absent',
      sessionId: 'child-session',
      env: { [SUBAGENT_CHILD_ENV]: '1' },
      expected: 'child-session',
    },
    {
      name: 'keeps an ordinary Pi session key',
      sessionId: 'ordinary-session',
      env: {},
      expected: 'ordinary-session',
    },
  ])('$name', ({ sessionId, env, expected }) => {
    const paths = new FileEditPaths();
    expect(paths.sessionKey(sessionId, env)).toBe(expected);
  });

  it('roots fallback paths in the discovered Pi agent directory', () => {
    const agentDirectory = path.join(directory, 'pi-agent');
    fs.mkdirSync(agentDirectory);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
    const paths = new FileEditPaths();
    const first = paths.timelinePath(directory, 'session-one');
    const second = paths.timelinePath(directory, 'session-one');

    expect(first).toBe(second);
    expect(first.startsWith(`${agentDirectory}${path.sep}`)).toBe(true);
    expect(first).not.toContain(`${path.sep}.doom${path.sep}`);
    expect(first).toMatch(/\.jsonl$/u);
  });

  it('renders a useful empty state', () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      inverse: (text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const component = new FileEditOverlayComponent(
      { terminal: { rows: 42 }, requestRender: () => undefined },
      theme,
      {
        cwd: directory,
        entries: [],
        diffs: [],
        editor: undefined,
        configPath: '/tmp/config.yaml',
      },
      () => undefined,
    );
    expect(component.render(120).join('\n')).toContain('No files edited in this session yet.');
  });

  it('renders edited file details and dispatches every overlay key action', () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      inverse: (text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const requestRender = vi.fn();
    const view = {
      cwd: directory,
      entries: [{ path: path.join(directory, 'edited.ts'), tool: 'edit' as const, at: 10, count: 3 }],
      diffs: [
        {
          path: path.join(directory, 'edited.ts'),
          state: 'modified' as const,
          lines: ['@@ -1 +1 @@', '-old', '+new'],
          additions: 1,
          removals: 1,
          tracked: true,
          truncated: false,
          suggestedLine: 1,
        },
      ],
      editor: { template: 'nvim +{line} {file}', source: 'configured' as const },
      configPath: '/tmp/config.yaml',
    };
    const renderComponent = new FileEditOverlayComponent(
      { terminal: { rows: 42 }, requestRender },
      theme,
      view,
      vi.fn(),
    );
    const rendered = renderComponent.render(120).join('\n');
    expect(rendered).toContain('edited.ts');
    expect(rendered).toContain('vs git HEAD');
    expect(rendered).toContain('nvim +{line} {file}');
    expect(rendered).not.toMatch(/\.\.\.│/u);
    const narrow = renderComponent.render(40);
    expect(narrow).toHaveLength(42);
    expect(narrow.join('\n')).toContain('EDITED THIS SESSION');
    expect(narrow.join('\n')).toContain('edited.ts');
    renderComponent.handleInput('\u001b[A');
    renderComponent.handleInput('\u001b[B');
    renderComponent.handleInput('x');
    expect(requestRender).toHaveBeenCalled();

    for (const [input, action] of [
      ['\r', 'open'],
      ['y', 'copy'],
      ['r', 'refresh'],
      ['\u001b', 'close'],
    ] as const) {
      const done = vi.fn();
      new FileEditOverlayComponent({ requestRender }, theme, view, done).handleInput(input);
      expect(done).toHaveBeenCalledWith({ action, index: 0 });
    }

    // `c` used to open an editor-command prompt. Configuration moved to the
    // SPC e c panel, so the key must no longer resolve to anything here.
    const unbound = vi.fn();
    new FileEditOverlayComponent({ requestRender }, theme, view, unbound).handleInput('c');
    expect(unbound).not.toHaveBeenCalled();
  });
});
