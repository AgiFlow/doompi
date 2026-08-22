import type { DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import { describe, expect, it, vi } from 'vitest';
import { AUTOCOMPACT_EVENT, createAutocompactTelemetry } from '../src/adapters/telemetry/logSinkTelemetry.ts';

type TelemetryHandle = Awaited<ReturnType<NonNullable<DoomTelemetryOptions['telemetryFactory']>>>;

function createTelemetryDouble() {
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
  const telemetry = {
    backend: 'logsink',
    enabled: true,
    logger,
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    runInSpan: vi.fn(async (_name: string, _options: unknown, callback: (span: undefined) => unknown) =>
      callback(undefined),
    ),
  } as unknown as TelemetryHandle;
  const telemetryFactory = vi.fn(async () => telemetry);
  return { logger, telemetry, telemetryFactory };
}

describe('autocompact telemetry', () => {
  it('records sanitized checkpoint failures and trace configuration', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createAutocompactTelemetry({
      cwd: '/workspace',
      env: { AGENT_SESSION_ID: 'agent-session', PARENT_AGENT_SESSION_ID: 'parent-session' },
      telemetryFactory,
    });

    await telemetry.recordError(AUTOCOMPACT_EVENT.checkpointFailed, new Error('private summary'), {
      'autocompact.request.id': 'request-1',
    });

    expect(telemetryFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'doom-autocompact',
        packageName: '@agimon-ai/doompi-autocompact',
        enableLogs: true,
        enableTraces: true,
        headers: {
          'x-agent': 'doom-autocompact',
          'x-agent-session-id': expect.stringMatching(/^id_[0-9a-f]+$/),
          'x-agent-parent-session-id': expect.stringMatching(/^id_[0-9a-f]+$/),
        },
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(AUTOCOMPACT_EVENT.checkpointFailed, {
      attributes: {
        'telemetry.package': '@agimon-ai/doompi-autocompact',
        'autocompact.request.id': expect.stringMatching(/^id_[0-9a-f]+$/),
        'error.type': 'Error',
        outcome: 'error',
      },
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private summary');
  });

  it('records lifecycle events and spans', async () => {
    const { logger, telemetry, telemetryFactory } = createTelemetryDouble();
    const reporter = createAutocompactTelemetry({ telemetryFactory });

    const result = await reporter.runInSpan('doom_autocompact.checkpoint', { 'autocompact.pass': 2 }, async () => {
      await reporter.recordEvent(AUTOCOMPACT_EVENT.checkpointStarted, { 'autocompact.pass': 2 });
      return 'checkpoint';
    });

    expect(result).toBe('checkpoint');
    expect(telemetry.runInSpan).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(AUTOCOMPACT_EVENT.checkpointStarted, {
      attributes: { 'telemetry.package': '@agimon-ai/doompi-autocompact', 'autocompact.pass': 2 },
    });
  });

  it('preserves callback failures', async () => {
    const { telemetryFactory } = createTelemetryDouble();
    const reporter = createAutocompactTelemetry({ telemetryFactory });
    const failure = new Error('checkpoint failed');

    await expect(
      reporter.runInSpan('doom_autocompact.checkpoint', {}, async () => Promise.reject(failure)),
    ).rejects.toBe(failure);
  });

  it('keeps sink failures out of compaction', async () => {
    const warn = vi.fn();
    const reporter = createAutocompactTelemetry({
      telemetryFactory: vi.fn(async () => {
        throw new Error('sink unavailable');
      }),
      warn,
    });

    await expect(reporter.recordEvent(AUTOCOMPACT_EVENT.contextCommitted)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('flushes and shuts down initialized telemetry', async () => {
    const { telemetry, telemetryFactory } = createTelemetryDouble();
    const reporter = createAutocompactTelemetry({ telemetryFactory });

    await reporter.recordEvent(AUTOCOMPACT_EVENT.contextCommitted);
    await reporter.flush();
    await reporter.shutdown();

    expect(telemetry.flush).toHaveBeenCalled();
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
  });
});
