import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { globalDoomConfigPath, repositoryDoomConfigPath } from '@agimon-ai/doompi-config/config';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { resolveWebTemplateDecision } from '../../src/builders/server/webTemplateDecision';

const directories: string[] = [];

function fixture(): {
  homeDirectory: string;
  cwd: string;
  workspaces: { id: string; root: string }[];
  environment: NodeJS.ProcessEnv;
  notice: Mock<(message: string) => void>;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-template-'));
  directories.push(directory);
  const homeDirectory = path.join(directory, 'home');
  const root = path.join(directory, 'repo');
  fs.mkdirSync(homeDirectory);
  fs.mkdirSync(root);
  return {
    homeDirectory,
    cwd: root,
    workspaces: [{ id: 'launch', root }],
    environment: {},
    notice: vi.fn<(message: string) => void>(),
  };
}

function config(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('resolveWebTemplateDecision', () => {
  it('uses the containing launch workspace repository override, independent of remembered workspace order', () => {
    const options = fixture();
    config(globalDoomConfigPath(options.homeDirectory), 'web:\n  template: global\n');
    config(repositoryDoomConfigPath(options.cwd), 'web:\n  template: repository\n');
    options.workspaces.unshift({ id: 'unrelated', root: path.join(options.homeDirectory, 'other') });
    options.cwd = path.join(options.cwd, 'packages', 'web');

    expect(resolveWebTemplateDecision(options)).toEqual({
      id: 'repository',
      mount: { scope: 'workspace', workspaceId: 'launch' },
    });
  });

  it('matches the longest admitted ancestor and does not match sibling path prefixes', () => {
    const options = fixture();
    const root = options.cwd;
    options.workspaces.push({ id: 'nested', root: path.join(root, 'nested') });
    options.cwd = path.join(root, 'nested', 'src');
    expect(resolveWebTemplateDecision(options)).toEqual({ mount: { scope: 'workspace', workspaceId: 'nested' } });

    options.cwd = `${root}-sibling`;
    expect(resolveWebTemplateDecision(options)).toEqual({ mount: { scope: 'global' } });
    expect(options.workspaces).toEqual([
      { id: 'launch', root },
      { id: 'nested', root: path.join(root, 'nested') },
    ]);
  });

  it('uses only global config for a launch outside admitted roots and omits an unset id', () => {
    const options = fixture();
    config(repositoryDoomConfigPath(options.cwd), 'web:\n  template: repository\n');
    options.cwd = options.homeDirectory;
    expect(resolveWebTemplateDecision(options)).toEqual({ mount: { scope: 'global' } });

    config(globalDoomConfigPath(options.homeDirectory), 'web:\n  template: global\n');
    expect(resolveWebTemplateDecision(options)).toEqual({ id: 'global', mount: { scope: 'global' } });
  });

  it('keeps normal initial admission canonical for a member checkout outside its workspace root', () => {
    const options = fixture();
    config(repositoryDoomConfigPath(options.cwd), 'web:\n  template: canonical\n');
    config(globalDoomConfigPath(options.homeDirectory), 'web:\n  template: global\n');
    options.cwd = path.join(options.homeDirectory, 'worktree');
    expect(resolveWebTemplateDecision({ ...options, launchWorkspaceId: 'launch' })).toEqual({
      id: 'canonical',
      mount: { scope: 'workspace', workspaceId: 'launch' },
    });
    // A no-session launch does not admit a member checkout to discover its canonical root.
    expect(resolveWebTemplateDecision(options)).toEqual({ id: 'global', mount: { scope: 'global' } });
  });

  it('reads changed settings fresh on each compositions request', () => {
    const options = fixture();
    const file = repositoryDoomConfigPath(options.cwd);
    config(file, 'web:\n  template: first\n');
    expect(resolveWebTemplateDecision(options).id).toBe('first');
    config(file, 'web:\n  template: second\n');
    expect(resolveWebTemplateDecision(options).id).toBe('second');
    config(file, '{}\n');
    expect(resolveWebTemplateDecision(options).id).toBeUndefined();
  });

  it('warns and preserves the mount without an id when config cannot be parsed', () => {
    const options = fixture();
    config(repositoryDoomConfigPath(options.cwd), 'web: [\n');
    expect(resolveWebTemplateDecision(options)).toEqual({ mount: { scope: 'workspace', workspaceId: 'launch' } });
    expect(options.notice).toHaveBeenCalledWith(expect.stringContaining('Web template configuration unavailable:'));
  });
});
