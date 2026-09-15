import type { LogMetricsReport } from '@agimon-ai/log-sink-mcp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMetricsSource } from '../src/services/metricsSource';

const { resolveLogSinkPort, resolveLogSinkInstance, createAsyncLogMetricsReader, workerReader } = vi.hoisted(() => ({
  resolveLogSinkPort: vi.fn(),
  resolveLogSinkInstance: vi.fn(),
  createAsyncLogMetricsReader: vi.fn(),
  workerReader: { getMetrics: vi.fn(), close: vi.fn() },
}));

vi.mock('@agimon-ai/log-sink-mcp', () => ({
  createAsyncLogMetricsReader,
  resolveLogSinkPort,
  resolveLogSinkInstance,
}));

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
  createAsyncLogMetricsReader.mockReturnValue(workerReader);
  workerReader.getMetrics.mockResolvedValue(REPORT);
  workerReader.close.mockResolvedValue(undefined);
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

  it('falls back to the worker when sink discovery is unavailable', async () => {
    resolveLogSinkPort.mockRejectedValue(new Error('sink discovery unavailable'));
    const source = createMetricsSource({ cwd: '/standalone/package' });

    await expect(source.query(QUERY)).resolves.toEqual(REPORT);

    expect(workerReader.getMetrics).toHaveBeenCalledWith(undefined, {
      groupBy: 'session',
      period: 'day',
      sort: 'total-tokens',
      limit: 6,
      toolLimit: 1,
    });
    expect(source.lastTransport()).toBe('worker');
  });

  it('falls back to the worker when the historical HTTP response is stale', async () => {
    resolveLogSinkPort.mockResolvedValue({ endpoint: 'http://127.0.0.1:4318' });
    const fetchMock = vi.fn(
      async (_input: unknown) => new Response(JSON.stringify({ error: 'older sink' }), { status: 200 }),
    );
    const source = createMetricsSource({
      cwd: '/standalone/package',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(source.query(QUERY)).resolves.toEqual(REPORT);

    expect(workerReader.getMetrics).toHaveBeenCalledOnce();
    expect(source.lastTransport()).toBe('worker');
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
    const source = createMetricsSource({ cwd: '/standalone/package', ...IDENTITY });

    await expect(source.query(QUERY)).resolves.toEqual(REPORT);
    expect(source.instance?.()).toBeUndefined();
    expect(createAsyncLogMetricsReader).toHaveBeenCalledWith({ cwd: '/standalone/package' });
  });

  it('pins the worker reader to the resolved database', async () => {
    resolveLogSinkPort.mockResolvedValue(undefined);
    const source = createMetricsSource({ cwd: '/standalone/package', ...IDENTITY });

    await expect(source.query(QUERY)).resolves.toEqual(REPORT);

    expect(createAsyncLogMetricsReader).toHaveBeenCalledWith({ dbPath: LOCAL_INSTANCE.dbPath });
    expect(source.lastTransport()).toBe('worker');
  });

  it('propagates a worker failure after both transports are unavailable', async () => {
    resolveLogSinkPort.mockResolvedValue(undefined);
    const failure = new Error('metrics worker failed');
    workerReader.getMetrics.mockRejectedValue(failure);
    const source = createMetricsSource();

    await expect(source.query(QUERY)).rejects.toBe(failure);
    expect(source.lastTransport()).toBeUndefined();
  });

  it('closes a worker reader created by a fallback query', async () => {
    resolveLogSinkPort.mockResolvedValue(undefined);
    const source = createMetricsSource();
    await source.query(QUERY);

    await source.close?.();

    expect(workerReader.close).toHaveBeenCalledOnce();
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

  it('sends the same filters when it falls back to the worker', async () => {
    resolveLogSinkPort.mockResolvedValue(undefined);
    const source = createMetricsSource({ ...IDENTITY });

    const filter = { model: 'claude-opus-5', sessionId: 'id_abc' };
    await source.query({ ...QUERY, filter });

    expect(workerReader.getMetrics).toHaveBeenCalledWith(filter, expect.any(Object));
  });

  it('passes no filters when the caller narrowed nothing', async () => {
    resolveLogSinkPort.mockResolvedValue(undefined);

    await createMetricsSource({ ...IDENTITY }).query(QUERY);

    expect(workerReader.getMetrics).toHaveBeenCalledWith(undefined, expect.any(Object));
  });
});
