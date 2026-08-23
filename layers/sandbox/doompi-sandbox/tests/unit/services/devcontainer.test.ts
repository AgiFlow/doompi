import { describe, expect, it } from 'vitest';
import {
  bootstrapCommand,
  containerWorkspacePath,
  mapForwardArgs,
  devcontainerExecArgs,
  devcontainerUpArgs,
  parseDevcontainerUp,
} from '../../../src/services/devcontainer.ts';

describe('devcontainerUpArgs', () => {
  it('brings the workspace container up and asks for machine readable output', () => {
    expect(devcontainerUpArgs({ repoRoot: '/repo' })).toEqual([
      'up',
      '--workspace-folder',
      '/repo',
      '--log-format',
      'json',
    ]);
  });

  it('mounts the broker socket directory when the broker uses one', () => {
    const args = devcontainerUpArgs({ repoRoot: '/repo', socketDirectory: '/tmp/brk', socketTarget: '/run/doompi' });

    expect(args).toContain('--mount');
    expect(args).toContain('type=bind,source=/tmp/brk,target=/run/doompi');
  });

  it('mounts nothing when the broker is on a host port', () => {
    expect(devcontainerUpArgs({ repoRoot: '/repo' })).not.toContain('--mount');
  });
});

describe('parseDevcontainerUp', () => {
  it('takes the container id from the outcome record', () => {
    const stdout = [
      '{"type":"text","level":3,"text":"building"}',
      '{"outcome":"success","containerId":"abc123","remoteUser":"node"}',
    ].join('\n');

    expect(parseDevcontainerUp(stdout)).toEqual({ containerId: 'abc123' });
  });

  it('prefers the last outcome when the stream carries several', () => {
    const stdout = ['{"outcome":"error","message":"first try"}', '{"outcome":"success","containerId":"final"}'].join(
      '\n',
    );

    expect(parseDevcontainerUp(stdout).containerId).toBe('final');
  });

  it('reports the CLI description when the container did not start', () => {
    const stdout = '{"outcome":"error","message":"boom","description":"docker build failed"}';

    expect(parseDevcontainerUp(stdout)).toEqual({ error: 'docker build failed' });
  });

  it('reports an unusable stream rather than guessing', () => {
    expect(parseDevcontainerUp('not json at all').error).toMatch(/no outcome/);
    expect(parseDevcontainerUp('{"outcome":"success"}').error).toMatch(/no container id/);
  });
});

describe('bootstrapCommand', () => {
  it('installs the pinned distribution only when it is missing', () => {
    const [shell, flag, script] = bootstrapCommand('1.2.3');

    expect([shell, flag]).toEqual(['sh', '-c']);
    expect(script).toContain('command -v doompi');
    expect(script).toContain('npm install -g @agimon-ai/doompi@1.2.3');
  });

  it('explains itself when the container has no npm', () => {
    expect(bootstrapCommand('1.2.3')[2]).toContain('no npm to install DoomPi with');
  });
});

describe('devcontainerExecArgs', () => {
  const base = {
    containerId: 'abc123',
    cwd: '/workspaces/repo',
    environment: { DOOMPI_SANDBOX: '1', ANTHROPIC_API_KEY: 'token' },
    command: ['doompi', '--major-mode', 'copilot'],
  };

  it('attaches a terminal and passes the environment through the engine', () => {
    const args = devcontainerExecArgs({ ...base, hasTty: true });

    expect(args.slice(0, 3)).toEqual(['exec', '-i', '-t']);
    expect(args).toContain('ANTHROPIC_API_KEY=token');
    expect(args).toContain('DOOMPI_SANDBOX=1');
    expect(args.join(' ')).toContain('-w /workspaces/repo');
    expect(args.slice(-4)).toEqual(['abc123', 'doompi', '--major-mode', 'copilot']);
  });

  it('drops the terminal flag when the session has none', () => {
    const args = devcontainerExecArgs({ ...base, hasTty: false });

    expect(args.slice(0, 2)).toEqual(['exec', '-i']);
    expect(args).not.toContain('-t');
  });
});

describe('containerWorkspacePath', () => {
  it('maps the repository root onto the container workspace', () => {
    expect(containerWorkspacePath('/Users/me/repo', '/Users/me/repo', '/workspaces/repo')).toBe('/workspaces/repo');
  });

  it('keeps a subdirectory of the repository', () => {
    expect(containerWorkspacePath('/Users/me/repo', '/Users/me/repo/packages/app', '/workspaces/repo')).toBe(
      '/workspaces/repo/packages/app',
    );
  });

  it('falls back to the workspace for a path outside the repository', () => {
    expect(containerWorkspacePath('/Users/me/repo', '/somewhere/else', '/workspaces/repo')).toBe('/workspaces/repo');
  });
});

describe('mapForwardArgs', () => {
  it('rewrites forwarded host paths, since the workspace is mounted elsewhere', () => {
    const args = ['--major-mode', 'copilot', '--cwd', '/Users/me/repo', '--plugin-dir', '/Users/me/repo/plugins'];

    expect(mapForwardArgs(args, '/Users/me/repo', '/workspaces/repo')).toEqual([
      '--major-mode',
      'copilot',
      '--cwd',
      '/workspaces/repo',
      '--plugin-dir',
      '/workspaces/repo/plugins',
    ]);
  });

  it('leaves everything that is not a repository path alone', () => {
    const args = ['--major-mode', 'copilot', '--preset', 'default', '/Users/other/thing'];

    expect(mapForwardArgs(args, '/Users/me/repo', '/workspaces/repo')).toEqual(args);
  });
});
