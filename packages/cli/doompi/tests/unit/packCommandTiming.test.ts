import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCommand } from '../system/packHelpers';

const TIMING_PREFIX = 'System-test phase: ';
const COMMAND_TIMEOUT_MS = 5_000;

describe('packed system command timing', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      if (typeof chunk === 'string') output.push(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function phases(): unknown[] {
    return output
      .filter((line) => line.startsWith(TIMING_PREFIX))
      .map((line) => JSON.parse(line.slice(TIMING_PREFIX.length)) as unknown);
  }

  it('logs phase boundaries without changing captured command output', async () => {
    const cwd = process.cwd();
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("child stdout"); process.stderr.write("child stderr");'],
      cwd,
      process.env,
      COMMAND_TIMEOUT_MS,
      'successful sync',
    );

    expect(result).toEqual({ code: 0, stdout: 'child stdout', stderr: 'child stderr' });
    expect(phases()).toEqual([
      { phase: 'successful sync', status: 'started', cwd },
      {
        phase: 'successful sync',
        status: 'completed',
        cwd,
        elapsedMs: expect.any(Number),
        code: 0,
      },
    ]);
  });

  it('records failures without hiding the exit code or diagnostics', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stderr.write("sync failed"); process.exit(7);'],
      process.cwd(),
      process.env,
      COMMAND_TIMEOUT_MS,
      'failed sync',
    );

    expect(result.code).toBe(7);
    expect(result.stderr).toContain('sync failed');
    expect(phases()).toEqual([
      expect.objectContaining({ phase: 'failed sync', status: 'started' }),
      expect.objectContaining({ phase: 'failed sync', status: 'completed', elapsedMs: expect.any(Number), code: 7 }),
    ]);
  });

  it('preserves the command timeout and records its failed completion', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000);'],
      process.cwd(),
      process.env,
      100,
      'timed-out sync',
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Command failed');
    expect(phases()).toEqual([
      expect.objectContaining({ phase: 'timed-out sync', status: 'started' }),
      expect.objectContaining({ phase: 'timed-out sync', status: 'completed', code: result.code }),
    ]);
  });

  it('does not log timing for an unlabelled command', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("unchanged");'], process.cwd());

    expect(result).toEqual({ code: 0, stdout: 'unchanged', stderr: '' });
    expect(phases()).toEqual([]);
  });
});
