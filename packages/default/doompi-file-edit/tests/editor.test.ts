import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expandEditorTemplate, splitCommandLine } from '../src/adapters/process/commandLine.ts';
import { EditorLauncher } from '../src/adapters/EditorLauncher/EditorLauncher.ts';
import type { IEditorConfigService } from '../src/types/editorConfigService';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

function config(command: string | undefined): IEditorConfigService {
  return {
    path: () => '/tmp/config.yaml',
    packagePath: () => '/tmp/package-config.yaml',
    command: async () => command,
  };
}

describe('EditorLauncher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers configured, then VISUAL, then EDITOR, then fallback', async () => {
    expect(
      await new EditorLauncher(config('/bin/sh {file}')).resolve({
        PATH: '/bin',
        VISUAL: '/bin/echo',
        EDITOR: '/bin/cat',
      }),
    ).toMatchObject({ source: 'configured' });
    expect(
      await new EditorLauncher(config(undefined)).resolve({ PATH: '/bin', VISUAL: '/bin/echo', EDITOR: '/bin/cat' }),
    ).toMatchObject({ source: 'VISUAL' });
    expect(await new EditorLauncher(config(undefined)).resolve({ PATH: '/bin', EDITOR: '/bin/cat' })).toMatchObject({
      source: 'EDITOR',
    });
    expect(await new EditorLauncher(config(undefined)).resolve({ PATH: '/usr/bin:/bin' })).toMatchObject({
      source: 'fallback',
    });
  });

  it('returns undefined when no command is available', async () => {
    expect(await new EditorLauncher(config(undefined)).resolve({ PATH: '' }, 'linux')).toBeUndefined();
  });

  it('expands file and line placeholders without a shell', () => {
    expect(expandEditorTemplate('nvim +{line} "{file}"', '/tmp/a file.ts', 12)).toEqual([
      'nvim',
      '+12',
      '/tmp/a file.ts',
    ]);
  });

  it('parses trusted quoting and escaping and appends a missing file token', () => {
    expect(splitCommandLine(`code --goto 'a b' "c d" one\\ two`)).toEqual(['code', '--goto', 'a b', 'c d', 'one two']);
    expect(expandEditorTemplate('vi +{line}', '/tmp/a.ts', 7)).toEqual(['vi', '+7', '/tmp/a.ts']);
    expect(splitCommandLine('vi trailing\\')).toEqual(['vi', 'trailing\\']);
  });

  it('rejects empty commands and unterminated quotes', () => {
    expect(() => splitCommandLine('   ')).toThrow('must not be empty');
    expect(() => splitCommandLine("vi 'broken")).toThrow('unterminated quote');
    expect(() => splitCommandLine('vi "broken')).toThrow('unterminated quote');
  });

  it('restores the TUI and returns a failure when spawn fails', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    });
    const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
    const result = await new EditorLauncher(config('/bin/sh {file}')).launch('/tmp/a.ts', 1, tui);
    expect(result).toEqual({ success: false, error: 'spawn failed' });
    expect(tui.stop).toHaveBeenCalledOnce();
    expect(tui.start).toHaveBeenCalledOnce();
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });
});
