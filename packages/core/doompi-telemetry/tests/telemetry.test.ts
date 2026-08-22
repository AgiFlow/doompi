import type { NodeTelemetryHandle, NodeTelemetryOptions } from '@agimon-ai/log-sink-mcp/telemetry/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDoomTelemetry,
  createTelemetryHeaders,
  sanitizeTelemetryAttributes,
  subscribeTelemetryRecords,
} from '../src/exports/index.js';

interface MockHandleOptions {
  backend?: NodeTelemetryHandle['backend'];
  endpointSource?: NodeTelemetryHandle['endpointSource'];
  runInSpan?: NodeTelemetryHandle['runInSpan'];
}

function createMockHandle(options: MockHandleOptions = {}): NodeTelemetryHandle {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    getTraceContext: vi.fn(() => ({})),
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
  return {
    backend: options.backend ?? 'otel',
    enabled: true,
    trace: {} as NodeTelemetryHandle['trace'],
    log: {} as NodeTelemetryHandle['log'],
    logger,
    endpointSource: options.endpointSource ?? 'env',
    endpoint: 'http://logsink.test',
    getTraceContext: vi.fn(() => ({})),
    runInSpan: options.runInSpan ?? (async (_name, _spanOptions, callback) => callback(undefined)),
    flush: logger.flush,
    shutdown: logger.shutdown,
  } as unknown as NodeTelemetryHandle;
}

type MockFunction = ReturnType<typeof vi.fn>;

function mockLoggerMethod(handle: NodeTelemetryHandle, method: string): MockFunction {
  return Reflect.get(handle.logger, method) as MockFunction;
}

function mockHandleMethod(handle: NodeTelemetryHandle, method: string): MockFunction {
  return Reflect.get(handle, method) as MockFunction;
}

describe('metadata-only Doom telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops content-like attributes and hashes correlation identifiers', () => {
    const attributes = sanitizeTelemetryAttributes({
      'session.id': 'session-secret',
      'tool.input': 'rm -rf /',
      'error.message': 'private failure',
      'tool.duration_ms': 42,
      'gen_ai.usage.total_tokens': 12,
      'plan.outcome': 'completed',
      'prompt.length': 5,
      'message.count': 2,
      'command.exit_code': 1,
      'telemetry.package': '/private/package-path',
    });

    expect(attributes['session.id']).toMatch(/^id_[0-9a-f]+$/);
    expect(attributes).not.toHaveProperty('tool.input');
    expect(attributes).not.toHaveProperty('error.message');
    expect(attributes['tool.duration_ms']).toBe(42);
    expect(attributes['gen_ai.usage.total_tokens']).toBe(12);
    expect(attributes['plan.outcome']).toBe('completed');
    expect(attributes['prompt.length']).toBe(5);
    expect(attributes['message.count']).toBe(2);
    expect(attributes['command.exit_code']).toBe(1);
    expect(attributes).not.toHaveProperty('telemetry.package');
  });

  it('normalizes both session header aliases', () => {
    const headers = createTelemetryHeaders('doom-test', {
      PI_SESSION_ID: 'session-id',
      PARENT_AGENT_SESSION_ID: 'parent-id',
    });

    expect(headers['x-agent']).toBe('doom-test');
    expect(headers['x-agent-session-id']).toMatch(/^id_[0-9a-f]+$/);
    expect(headers['x-agent-parent-session-id']).toMatch(/^id_[0-9a-f]+$/);
    expect(headers['x-agent-session-id']).not.toBe('session-id');
  });

  it('sanitizes correlation environment before creating the LogSink transport', async () => {
    const handle = createMockHandle();
    let transportEnv: NodeJS.ProcessEnv | undefined;
    let factoryOptions: NodeTelemetryOptions | undefined;
    const resolvedEndpoints = {
      endpointSource: 'env' as const,
      endpoint: 'http://logsink.test',
      tracesEndpoint: 'http://logsink.test/v1/traces',
      logsEndpoint: 'http://logsink.test/v1/logs',
    };
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {
        AGENT_SESSION_ID: 'private-session',
        PI_SESSION_ID: 'private-pi-session',
        AGENT_PARENT_SESSION_ID: 'private-parent-alias',
        PARENT_AGENT_SESSION_ID: 'private-parent',
        WORKFLOW_RUN_ID: 'private-run',
        WORKFLOW_NAME: 'private workflow content',
        WORKFLOW_WORKSPACE: '/private/workspace',
      },
      endpointResolver: async () => resolvedEndpoints,
      telemetryFactory: async (options) => {
        factoryOptions = options;
        transportEnv = options.env;
        return handle;
      },
    });

    await telemetry.recordEvent('doom_test.started');

    expect(transportEnv?.AGENT_SESSION_ID).toMatch(/^id_[0-9a-f]+$/);
    expect(transportEnv?.PARENT_AGENT_SESSION_ID).toMatch(/^id_[0-9a-f]+$/);
    expect(transportEnv).not.toHaveProperty('PI_SESSION_ID');
    expect(transportEnv).not.toHaveProperty('AGENT_PARENT_SESSION_ID');
    expect(Object.keys(transportEnv ?? {}).some((key) => key.startsWith('WORKFLOW_'))).toBe(false);
    expect(factoryOptions?.discoverEndpoint).toBe(false);
    expect(factoryOptions?.resolvedEndpoints).toEqual(resolvedEndpoints);
  });

  it('uses an injected adapter without requiring endpoint resolution or repository paths', async () => {
    const handle = createMockHandle();
    let factoryOptions: NodeTelemetryOptions | undefined;
    const telemetryFactory = vi.fn(async (options: NodeTelemetryOptions) => {
      factoryOptions = options;
      return handle;
    });
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      telemetryFactory,
    });

    await telemetry.recordEvent('doom_test.started');
    await telemetry.shutdown();

    expect(telemetryFactory).toHaveBeenCalledOnce();
    expect(factoryOptions?.cwd).toBeUndefined();
    expect(factoryOptions?.workspaceRoot).toBeUndefined();
    expect(mockHandleMethod(handle, 'shutdown')).toHaveBeenCalledOnce();
  });

  it('is a no-op when no endpoint exists and file fallback is not explicit', async () => {
    const telemetryFactory = vi.fn(async () => createMockHandle());
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'none' }),
      telemetryFactory,
    });

    await telemetry.recordEvent('doom_test.started', { outcome: 'started' });

    expect(telemetryFactory).not.toHaveBeenCalled();
    expect(telemetry.status().enabled).toBe(false);
  });

  it('allows file fallback only when explicitly enabled', async () => {
    const handle = createMockHandle({ backend: 'file', endpointSource: 'none' });
    const telemetryFactory = vi.fn(async () => handle);
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      allowFileFallback: true,
      endpointResolver: async () => ({ endpointSource: 'none' }),
      telemetryFactory,
    });

    await telemetry.recordEvent('doom_test.started', { outcome: 'started' });

    expect(telemetryFactory).toHaveBeenCalledOnce();
    expect((handle.logger as unknown as Record<string, ReturnType<typeof vi.fn>>).info).toHaveBeenCalledWith(
      'doom_test.started',
      {
        attributes: { 'telemetry.package': undefined, outcome: 'started' },
      },
    );
  });

  it('rejects an implicit file backend when fallback is not explicit', async () => {
    const handle = createMockHandle({ backend: 'file', endpointSource: 'env' });
    const telemetryFactory = vi.fn(async () => handle);
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory,
    });

    await telemetry.recordEvent('doom_test.started');

    expect(mockHandleMethod(handle, 'shutdown')).toHaveBeenCalledOnce();
    expect(telemetry.status().enabled).toBe(false);
  });

  it('retries initialization after a failed attempt', async () => {
    const handle = createMockHandle();
    const telemetryFactory = vi
      .fn<(_: NodeTelemetryOptions) => Promise<NodeTelemetryHandle>>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(handle);
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      retryDelayMs: 0,
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory,
    });

    await telemetry.recordEvent('doom_test.first');
    await telemetry.recordEvent('doom_test.second');

    expect(telemetryFactory).toHaveBeenCalledTimes(2);
    expect((handle.logger as unknown as Record<string, ReturnType<typeof vi.fn>>).info).toHaveBeenCalledOnce();
  });

  it('executes a callback once when span creation fails', async () => {
    const handle = createMockHandle({ runInSpan: vi.fn(async () => Promise.reject(new Error('span unavailable'))) });
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
    });
    const callback = vi.fn(async () => 'result');

    await expect(telemetry.runInSpan('doom_test.operation', {}, callback)).resolves.toBe('result');
    expect(callback).toHaveBeenCalledOnce();
  });

  it('records successful spans and sanitized error codes', async () => {
    const span = { setAttribute: vi.fn(), setStatus: vi.fn() };
    const handle = createMockHandle({
      runInSpan: vi.fn(async (_name, _options, callback) => callback(span as never)),
    });
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
    });
    const coded = Object.assign(new Error('private'), { code: 'ECONNRESET' });

    await telemetry.runInSpan('doom_test.operation', {}, async () => 'ok');
    await telemetry.recordError('doom_test.failed', coded);

    expect(span.setAttribute).toHaveBeenCalledWith('outcome', 'success');
    expect(mockLoggerMethod(handle, 'error')).toHaveBeenCalledWith(
      'doom_test.failed',
      expect.objectContaining({ attributes: expect.objectContaining({ 'error.code': 'ECONNRESET' }) }),
    );
  });

  it('exports Error details only when the caller explicitly opts in', async () => {
    const handle = createMockHandle();
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
    });
    const failure = new Error('extension hook failed');
    failure.stack = 'Error: extension hook failed\n    at repositoryHooks.mjs:42:7';

    await telemetry.recordError(
      'doom_test.extension_failed',
      failure,
      { 'failure.kind': 'extension' },
      {
        includeException: true,
      },
    );

    expect(mockLoggerMethod(handle, 'error')).toHaveBeenCalledWith(
      'doom_test.extension_failed',
      expect.objectContaining({ exception: failure }),
    );
  });

  it('exports a non-Error thrown value only when the caller explicitly opts in', async () => {
    const handle = createMockHandle();
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
    });
    const failure = 'string extension failure';

    await telemetry.recordError('doom_test.extension_failed', failure, undefined, { includeException: true });

    expect(mockLoggerMethod(handle, 'error')).toHaveBeenCalledWith(
      'doom_test.extension_failed',
      expect.objectContaining({ exception: failure }),
    );
  });

  it('keeps exception details out of default error records', async () => {
    const handle = createMockHandle();
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
    });

    await telemetry.recordError('doom_test.failed', new Error('private failure'));

    expect(mockLoggerMethod(handle, 'error')).toHaveBeenCalledWith(
      'doom_test.failed',
      expect.not.objectContaining({ exception: expect.anything() }),
    );
  });

  it('rethrows callback errors without exporting them', async () => {
    const handle = createMockHandle();
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
    });

    const failure = new Error('private failure');
    await expect(telemetry.runInSpan('doom_test.operation', {}, async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect((handle.logger as unknown as Record<string, ReturnType<typeof vi.fn>>).error).not.toHaveBeenCalled();
  });

  it('rethrows non-Error callback failures without exporting their value', async () => {
    const span = { setAttribute: vi.fn(), setStatus: vi.fn() };
    const handle = createMockHandle({
      runInSpan: vi.fn(async (_name, _options, callback) => callback(span as never)),
    });
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
    });
    const failure = 'private callback value';

    await expect(telemetry.runInSpan('doom_test.operation', {}, async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(span.setAttribute).toHaveBeenCalledWith('error.type', 'StringError');
    expect(JSON.stringify(span.setAttribute.mock.calls)).not.toContain(failure);
  });

  it('flushes an initialization already in flight', async () => {
    const handle = createMockHandle();
    let resolveFactory: ((value: NodeTelemetryHandle) => void) | undefined;
    const telemetryFactory = vi.fn(
      () =>
        new Promise<NodeTelemetryHandle>((resolve) => {
          resolveFactory = resolve;
        }),
    );
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory,
    });

    const record = telemetry.recordEvent('doom_test.started');
    await vi.waitFor(() => expect(telemetryFactory).toHaveBeenCalledOnce());
    const flushed = telemetry.flush();
    resolveFactory?.(handle);
    await Promise.all([record, flushed]);

    expect(mockHandleMethod(handle, 'flush')).toHaveBeenCalledOnce();
  });

  it('closes a handle that finishes initialization after shutdown begins', async () => {
    const handle = createMockHandle();
    let resolveFactory: ((value: NodeTelemetryHandle) => void) | undefined;
    const telemetryFactory = vi.fn(
      () =>
        new Promise<NodeTelemetryHandle>((resolve) => {
          resolveFactory = resolve;
        }),
    );
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory,
    });

    const record = telemetry.recordEvent('doom_test.started');
    await vi.waitFor(() => expect(telemetryFactory).toHaveBeenCalledOnce());
    const shutdown = telemetry.shutdown();
    resolveFactory?.(handle);
    await Promise.all([record, shutdown]);

    expect(mockHandleMethod(handle, 'shutdown')).toHaveBeenCalledOnce();
  });

  it('coalesces repeated shutdown during initialization and blocks later startup', async () => {
    const handle = createMockHandle();
    let resolveFactory: ((value: NodeTelemetryHandle) => void) | undefined;
    const telemetryFactory = vi.fn(
      () =>
        new Promise<NodeTelemetryHandle>((resolve) => {
          resolveFactory = resolve;
        }),
    );
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory,
    });

    const record = telemetry.recordEvent('doom_test.started');
    await vi.waitFor(() => expect(telemetryFactory).toHaveBeenCalledOnce());
    const firstShutdown = telemetry.shutdown();
    const secondShutdown = telemetry.shutdown();
    if (!resolveFactory) throw new Error('Expected the telemetry factory to be pending.');
    resolveFactory(handle);
    await Promise.all([record, firstShutdown, secondShutdown]);
    await telemetry.shutdown();
    await telemetry.recordEvent('doom_test.after_shutdown');

    expect(telemetryFactory).toHaveBeenCalledOnce();
    expect(mockHandleMethod(handle, 'shutdown')).toHaveBeenCalledOnce();
  });

  it('allows shutdown before initialization and keeps it idempotent', async () => {
    const telemetryFactory = vi.fn(async () => createMockHandle());
    const telemetry = createDoomTelemetry({ serviceName: 'doom-test', env: {}, telemetryFactory });

    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    await telemetry.recordEvent('doom_test.after_shutdown');

    expect(telemetryFactory).not.toHaveBeenCalled();
  });

  it('disables telemetry for both supported environment switches', async () => {
    for (const key of ['AGENT_TELEMETRY_DISABLED', 'OTEL_SDK_DISABLED']) {
      const telemetryFactory = vi.fn(async () => createMockHandle());
      const telemetry = createDoomTelemetry({
        serviceName: 'doom-test',
        env: { [key]: '1' },
        telemetryFactory,
      });

      await telemetry.recordEvent('doom_test.disabled');

      expect(telemetryFactory).not.toHaveBeenCalled();
      expect(telemetry.status().enabled).toBe(false);
    }
  });

  it('publishes status and tolerates observer and logger failures', async () => {
    const handle = createMockHandle();
    mockLoggerMethod(handle, 'warn').mockImplementation(() => {
      throw new Error('logger closed');
    });
    const warn = vi.fn();
    const onStatus = vi.fn();
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
      onStatus,
      warn,
    });
    const unsubscribe = subscribeTelemetryRecords(() => {
      throw new Error('observer closed');
    });

    await telemetry.recordDebug('doom_test.debug', { 'test.mode': 'safe' });
    await telemetry.recordWarning('doom_test.warning', new Error('private warning'));
    unsubscribe();

    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ backend: 'otel', enabled: true }));
    expect(warn).toHaveBeenCalled();
  });

  it('swallows flush and shutdown failures', async () => {
    const handle = createMockHandle();
    handle.flush = vi.fn(async () => {
      throw new Error('flush failed');
    });
    handle.shutdown = vi.fn(async () => {
      throw new Error('shutdown failed');
    });
    const warn = vi.fn();
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
      warn,
    });

    await telemetry.recordEvent('doom_test.started');
    await telemetry.flush();
    await telemetry.shutdown();

    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('names the real cause when flush rejects with an array of errors', async () => {
    // OpenTelemetry's BasicTracerProvider.forceFlush rejects with an array, not
    // an Error, which used to collapse to the useless token 'ObjectError'.
    // Reproduced as a rejected promise because that is the third-party contract
    // under test; production code here must still throw Error instances.
    const otelArrayRejection = [new Error('Export failed with retryable status'), new Error('Timeout')];
    const handle = createMockHandle();
    handle.flush = vi.fn(() => Promise.reject(otelArrayRejection));
    const warn = vi.fn();
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
      warn,
    });

    await telemetry.recordEvent('doom_test.started');
    await telemetry.flush();

    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('Export failed with retryable status');
    expect(message).toContain('Timeout');
    expect(message).not.toContain('ObjectError');
  });

  it('describes non-Error rejections instead of collapsing them to a token', async () => {
    const cases: { rejection: unknown; expected: string }[] = [
      { rejection: { code: 'ECONNREFUSED', port: 3027 }, expected: 'ECONNREFUSED' },
      { rejection: 'plain string failure', expected: 'plain string failure' },
      {
        rejection: new AggregateError([new Error('inner cause')], 'aggregate failed'),
        expected: 'inner cause',
      },
    ];

    for (const { rejection, expected } of cases) {
      const handle = createMockHandle();
      // Rejected promise, not `throw`: these non-Error shapes are what external
      // exporters reject with, and the point is that they stay readable.
      handle.flush = vi.fn(() => Promise.reject(rejection));
      const warn = vi.fn();
      const telemetry = createDoomTelemetry({
        serviceName: 'doom-test',
        env: {},
        endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
        telemetryFactory: async () => handle,
        warn,
      });

      await telemetry.recordEvent('doom_test.started');
      await telemetry.flush();

      expect(warn.mock.calls[0]?.[0]).toContain(expected);
    }
  });

  it('keeps the exported error.type attribute redacted to a token', async () => {
    // The local warning gained detail; the exported attribute must not.
    const handle = createMockHandle();
    const records: { attributes: Record<string, unknown> }[] = [];
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
      onRecord: (record) => records.push(record),
    });

    await telemetry.recordError('doom_test.failed', new Error('secret diagnostic text'));

    expect(records[0]?.attributes['error.type']).toBe('Error');
    expect(JSON.stringify(records[0]?.attributes)).not.toContain('secret diagnostic text');
  });

  it('rethrows callback errors without exporting their message', async () => {
    const handle = createMockHandle();
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
    });
    const failure = new Error('secret prompt and path');

    await expect(telemetry.runInSpan('doom_test.operation', {}, async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect((handle.logger as unknown as Record<string, ReturnType<typeof vi.fn>>).error).not.toHaveBeenCalled();
  });

  it('publishes sanitized records and shuts down idempotently', async () => {
    const handle = createMockHandle();
    const telemetry = createDoomTelemetry({
      serviceName: 'doom-test',
      packageName: '@test/package',
      env: {},
      endpointResolver: async () => ({ endpointSource: 'env', endpoint: 'http://logsink.test' }),
      telemetryFactory: async () => handle,
    });
    const observer = vi.fn();
    const unsubscribe = subscribeTelemetryRecords(observer);

    await telemetry.recordError('doom_test.failed', new Error('secret message'), {
      'tool.result.error': true,
      'error.message': 'secret message',
    });
    await telemetry.shutdown();
    await telemetry.shutdown();
    unsubscribe();

    expect(observer).toHaveBeenCalledWith({
      event: 'doom_test.failed',
      level: 'error',
      attributes: {
        'telemetry.package': '@test/package',
        'tool.result.error': true,
        'error.type': 'Error',
        outcome: 'error',
      },
    });
    expect(mockHandleMethod(handle, 'shutdown')).toHaveBeenCalledOnce();
    expect(mockLoggerMethod(handle, 'error')).toHaveBeenCalledWith('doom_test.failed', {
      attributes: {
        'telemetry.package': '@test/package',
        'tool.result.error': true,
        'error.type': 'Error',
        outcome: 'error',
      },
    });
  });
});
