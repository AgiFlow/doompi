import { describe, expect, it } from 'vitest';
import { parseRunnersCommand } from '../../src/services/runnersCommand';
import { launchProblems, RUNNER_SHELL_REQUEST, runnerLaunchLine } from '../../src/web/lib/launchLine';

/**
 * The cockpit writes the launch line and the session parses it, in different
 * bundles that may not import each other. Nothing but this file proves the two
 * still agree, so every field the form can set is round-tripped here.
 */

describe('the launch line the cockpit sends', () => {
  it('round-trips a plain command', () => {
    const parsed = parseRunnersCommand(runnerLaunchLine({ command: 'pnpm test' }).replace('/runners ', ''));

    expect(parsed).toEqual({ kind: 'start', command: 'pnpm test', interactive: false });
  });

  it('round-trips every field the form can set', () => {
    const line = runnerLaunchLine({
      command: 'pnpm build',
      cwd: '/workspace/repo',
      name: 'build',
      interactive: true,
    });

    expect(parseRunnersCommand(line.replace('/runners ', ''))).toEqual({
      kind: 'start',
      command: 'pnpm build',
      cwd: '/workspace/repo',
      name: 'build',
      interactive: true,
    });
  });

  it('survives a directory with spaces in it', () => {
    const line = runnerLaunchLine({ command: 'ls', cwd: '/Users/me/My Projects/app' });

    expect(parseRunnersCommand(line.replace('/runners ', ''))).toMatchObject({
      cwd: '/Users/me/My Projects/app',
      command: 'ls',
    });
  });

  it('keeps a command that carries an equals sign, which a pair would have swallowed', () => {
    const line = runnerLaunchLine({ command: 'FOO=bar pnpm test' });

    expect(parseRunnersCommand(line.replace('/runners ', '')).kind).toBe('start');
    expect(parseRunnersCommand(line.replace('/runners ', ''))).toMatchObject({ command: 'FOO=bar pnpm test' });
  });

  it("keeps a command carrying its own separator, so 'pnpm test -- --watch' arrives whole", () => {
    const line = runnerLaunchLine({ command: 'pnpm test -- --watch', name: 'watch' });

    expect(parseRunnersCommand(line.replace('/runners ', ''))).toMatchObject({
      name: 'watch',
      command: 'pnpm test -- --watch',
    });
  });

  it('starts a login shell without asking for a command', () => {
    const line = runnerLaunchLine(RUNNER_SHELL_REQUEST);

    expect(parseRunnersCommand(line.replace('/runners ', ''))).toEqual({
      kind: 'start',
      command: 'exec "${SHELL:-/bin/bash}" -l',
      name: 'shell',
      interactive: true,
    });
  });
  it('refuses to send a runner with no command', () => {
    expect(launchProblems({ command: '   ' })).toHaveLength(1);
    expect(launchProblems({ command: 'pnpm test' })).toEqual([]);
  });
});

describe('the /runners start verb', () => {
  it('takes a bare command with no separator, the way it looks typed by hand', () => {
    expect(parseRunnersCommand('start pnpm build')).toEqual({
      kind: 'start',
      command: 'pnpm build',
      interactive: false,
    });
  });

  it('reports an empty command rather than starting nothing', () => {
    expect(parseRunnersCommand('start')).toEqual({ kind: 'start', command: '', interactive: false });
  });

  it('still opens Runner Space for a bare /runners, and still stops by id', () => {
    expect(parseRunnersCommand('')).toEqual({ kind: 'space' });
    expect(parseRunnersCommand('stop abc123 took too long')).toEqual({
      kind: 'stop',
      id: 'abc123',
      reason: 'took too long',
    });
  });
});
