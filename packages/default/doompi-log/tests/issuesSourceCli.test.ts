import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The subprocess path, which every other issues test bypasses by injecting a
 * runner. What matters here is the argv the CLI is actually given and what
 * happens when it fails, since this is the only transport for issue detail.
 */

const { resolveLogSinkInstance, execFile } = vi.hoisted(() => ({
  resolveLogSinkInstance: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('@agimon-ai/log-sink-mcp', () => ({ resolveLogSinkInstance }));
vi.mock('node:child_process', () => ({ execFile }));

const { createIssuesSource } = await import('../src/adapters/node/issuesSource.ts');

const INSTANCE = { scope: 'local', dbPath: '/tmp/sink/session.db', registeredName: '@agimon-ai/doompi-log' };

type ExecDone = (error: Error | null, stdout: string, stderr: string) => void;

function answerWith(stdout: string, error: Error | null = null, stderr = ''): void {
  execFile.mockImplementation((_bin: string, _args: string[], _options: unknown, done: ExecDone) => {
    done(error, stdout, stderr);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveLogSinkInstance.mockReturnValue(INSTANCE);
});

describe('the issues subprocess', () => {
  it('asks the CLI for agent issues against the resolved database', async () => {
    answerWith(JSON.stringify({ totalIssues: 2 }));

    await createIssuesSource({}).query({ limit: 25 });

    const args = execFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain('logs');
    expect(args).toContain('agent-issues');
    expect(args[args.indexOf('--limit') + 1]).toBe('25');
    // The database is passed explicitly rather than left to the subprocess to
    // resolve from an inherited cwd, which could be a different instance.
    expect(args[args.indexOf('--db-path') + 1]).toBe('/tmp/sink/session.db');
    expect(args).not.toContain('--session-id');
  });

  it('adds the session filter only when one was asked for', async () => {
    answerWith(JSON.stringify({}));

    await createIssuesSource({}).query({ limit: 5, sessionId: 'id_abc' });

    const args = execFile.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf('--session-id') + 1]).toBe('id_abc');
  });

  it('omits the database flag when no instance resolved', async () => {
    resolveLogSinkInstance.mockReturnValue(undefined);
    answerWith(JSON.stringify({}));

    await createIssuesSource({}).query({ limit: 5 });

    expect(execFile.mock.calls[0]?.[1] as string[]).not.toContain('--db-path');
  });

  it('reports the subprocess stderr rather than a bare exit code', async () => {
    answerWith('', new Error('exit 1'), 'log-sink-mcp: unknown command');

    await expect(createIssuesSource({}).query({ limit: 5 })).rejects.toThrow('log-sink-mcp: unknown command');
  });

  it('falls back to the error message when the subprocess said nothing', async () => {
    answerWith('', new Error('spawn ENOENT'), '');

    await expect(createIssuesSource({}).query({ limit: 5 })).rejects.toThrow('spawn ENOENT');
  });

  it('refuses output that is not JSON', async () => {
    answerWith('not json at all');

    await expect(createIssuesSource({}).query({ limit: 5 })).rejects.toThrow(/cannot read/);
  });
});
