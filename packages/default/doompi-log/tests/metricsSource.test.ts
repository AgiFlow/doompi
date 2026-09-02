import type { LogMetricsReport } from '@agimon-ai/log-sink-mcp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetricsSource } from '../src/adapters/node/metricsSource.ts';

const { resolveLogSinkPort, resolveLogSinkInstance, execFile } = vi.hoisted(() => ({
  resolveLogSinkPort: vi.fn(),
  resolveLogSinkInstance: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('@agimon-ai/log-sink-mcp', () => ({ resolveLogSinkPort, resolveLogSinkInstance }));
vi.mock('node:child_process', () => ({ execFile }));

const REPORT = { timeline: [] } as unknown as LogMetricsReport;
const QUERY = { groupBy: 'session', period: 'day', limit: 6 } as const;
const ENVIRONMENT = { AGENT_OTEL_SERVICE_NAME: 'standalone-log' };
/** Mirrors the identity the Pi telemetry extension writes under. */
const IDENTITY = { packageName: '@agimon-ai/doompi-log', serviceName: 'pi' } as const;
const LOCAL_INSTANCE = {
  scope: 'local',
  dbPath: '/tmp/log-sink-mcp/standalone/session.db',
  registeredName: '@agimon-ai/doompi-log',
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveLogSinkInstance.mockReturnValue(LOCAL_INSTANCE);
});

describe('historical log metrics source', () => {
  it('queries the healthy HTTP sink with the bounded historical parameters', async () => {
    resolveLogSinkPort.mockResolvedValue({ endpoint: 'http://127.0.0.1:4318' });
    const fetchMock = vi.fn(async (_input: unknown) => new Response(JSON.stringify(REPORT), { status: 200 }));
    const source = createMetricsSource({
      cwd: '/standalone/package',
      env: ENVIRONMENT,
      ...IDENTITY,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(source.query(QUERY)).resolves.toEqual(REPORT);

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    const url = new URL(String(request));
    expect(url.pathname).toBe('/api/metrics');
    expect(url.searchParams.get('groupBy')).toBe('session');
    expect(url.searchParams.get('period')).toBe('day');
    expect(url.searchParams.get('sort')).toBe('total-tokens');
    expect(url.searchParams.get('limit')).toBe('6');
    expect(url.searchParams.get('toolLimit')).toBe('1');
    expect(url.pathname).not.toContain('agirepo');
    // The reader must ask for the same instance the telemetry writer registers
    // under, or it queries a different database than the session wrote to.
    expect(resolveLogSinkPort).toHaveBeenCalledWith({
      cwd: '/standalone/package',
      env: ENVIRONMENT,
      ...IDENTITY,
      healthCheck: true,
    });
    expect(resolveLogSinkInstance).toHaveBeenCalledWith({
      cwd: '/standalone/package',
      env: ENVIRONMENT,
      ...IDENTITY,
    });
    expect(source.lastTransport()).toBe('http');
  });

  it('falls back to the CLI when sink discovery is unavailable', async () => {
    resolveLogSinkPort.mockRejectedValue(new Error('sink discovery unavailable'));
    const cliRunner = vi.fn().mockResolvedValue(REPORT);
    const source = createMetricsSource({ cwd: '/standalone/package', cliRunner });

    await expect(source.query(QUERY)).resolves.toEqual(REPORT);

    expect(cliRunner).toHaveBeenCalledWith(QUERY);
    expect(source.lastTransport()).toBe('cli');
  });

  it('falls back to the CLI when the historical HTTP response is stale', async () => {
    resolveLogSinkPort.mockResolvedValue({ endpoint: 'http://127.0.0.1:4318' });
    const fetchMock = vi.fn(
      async (_input: unknown) => new Response(JSON.stringify({ error: 'older sink' }), { status: 200 }),
    );
    const cliRunner = vi.fn().mockResolvedValue(REPORT);
    const source = createMetricsSource({
      cwd: '/standalone/package',
      fetchImpl: fetchMock as unknown as typeof fetch,
      cliRunner,
    });

    await expect(source.query(QUERY)).resolves.toEqual(REPORT);

    expect(cliRunner).toHaveBeenCalledWith(QUERY);
    expect(source.lastTransport()).toBe('cli');
  });

  it('reports the resolved instance so an empty history names the database it read', () => {
    const source = createMetricsSource({ cwd: '/standalone/package', ...IDENTITY });

    expect(source.instance?.()).toEqual(LOCAL_INSTANCE);
  });

  it('keeps querying when the instance cannot be resolved', async () => {
    resolveLogSinkInstance.mockImplementation(() => {
      throw new Error('Invalid .logsink.yaml');
    });
    resolveLogSinkPort.mockResolvedValue(undefined);
    const cliRunner = vi.fn().mockResolvedValue(REPORT);
    const source = createMetricsSource({ cwd: '/standalone/package', ...IDENTITY, cliRunner });

    await expect(source.query(QUERY)).resolves.toEqual(REPORT);
    expect(source.instance?.()).toBeUndefined();
  });

  it('pins the CLI subprocess to the resolved database', async () => {
    resolveLogSinkPort.mockResolvedValue(undefined);
    execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, JSON.stringify(REPORT), '');
    });
    const source = createMetricsSource({ cwd: '/standalone/package', ...IDENTITY });

    await expect(source.query(QUERY)).resolves.toEqual(REPORT);

    // Without this the subprocess re-resolves an instance of its own from the
    // inherited cwd and environment, which is how the two paths drifted apart.
    const args = execFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--db-path');
    expect(args[args.indexOf('--db-path') + 1]).toBe(LOCAL_INSTANCE.dbPath);
    expect(source.lastTransport()).toBe('cli');
  });

  it('propagates a CLI failure after both transports are unavailable', async () => {
    resolveLogSinkPort.mockResolvedValue(undefined);
    const failure = new Error('metrics CLI failed');
    const cliRunner = vi.fn().mockRejectedValue(failure);
    const source = createMetricsSource({ cwd: '/standalone/package', cliRunner });

    await expect(source.query(QUERY)).rejects.toBe(failure);
    expect(source.lastTransport()).toBeUndefined();
  });
});

describe('narrowing one query to a single group', () => {
  it('sends each filter the sink names on the query string', async () => {
    resolveLogSinkPort.mockResolvedValue({ endpoint: 'http://127.0.0.1:4318' });
    const fetchMock = vi.fn(async (_input: unknown) => new Response(JSON.stringify(REPORT), { status: 200 }));
    const source = createMetricsSource({
      ...IDENTITY,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await source.query({
      ...QUERY,
      filter: { model: 'claude-opus-5', provider: 'anthropic', sessionId: 'id_abc', agentName: 'reviewer' },
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('model')).toBe('claude-opus-5');
    expect(url.searchParams.get('provider')).toBe('anthropic');
    expect(url.searchParams.get('sessionId')).toBe('id_abc');
    expect(url.searchParams.get('agentName')).toBe('reviewer');
  });

  it('omits an empty filter value rather than narrowing to nothing', async () => {
    resolveLogSinkPort.mockResolvedValue({ endpoint: 'http://127.0.0.1:4318' });
    const fetchMock = vi.fn(async (_input: unknown) => new Response(JSON.stringify(REPORT), { status: 200 }));
    const source = createMetricsSource({ ...IDENTITY, fetchImpl: fetchMock as unknown as typeof fetch });

    await source.query({ ...QUERY, filter: { model: '' } });

    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.has('model')).toBe(false);
  });

  it('sends the same filters as flags when it falls back to the CLI', async () => {
    // The two transports must narrow identically, or a daemon that is merely
    // unreachable would silently widen the reader's query.
    resolveLogSinkPort.mockResolvedValue(undefined);
    execFile.mockImplementation((_bin: string, _args: string[], _options: unknown, done: Function) => {
      done(null, JSON.stringify(REPORT), '');
    });
    const source = createMetricsSource({ ...IDENTITY });

    await source.query({ ...QUERY, filter: { model: 'claude-opus-5', sessionId: 'id_abc' } });

    const args = execFile.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5');
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('id_abc');
  });

  it('passes no filter flags when the caller narrowed nothing', async () => {
    resolveLogSinkPort.mockResolvedValue(undefined);
    execFile.mockImplementation((_bin: string, _args: string[], _options: unknown, done: Function) => {
      done(null, JSON.stringify(REPORT), '');
    });

    await createMetricsSource({ ...IDENTITY }).query(QUERY);

    const args = execFile.mock.calls[0]?.[1] as string[];
    expect(args.some((arg) => arg.startsWith('--model') || arg.startsWith('--session-id'))).toBe(false);
  });
});
