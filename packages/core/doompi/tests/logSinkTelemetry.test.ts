import type { DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import { describe, expect, it, vi } from 'vitest';
import { createHarnessTelemetry, HARNESS_EVENT, toFailureReporter } from '../src/exports/logSinkTelemetry';

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

describe('harness telemetry', () => {
  it('records metadata-only launcher failures with trace configuration', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createHarnessTelemetry({
      cwd: '/workspace',
      env: { AGENT_SESSION_ID: 'agent-session', AGENT_PARENT_SESSION_ID: 'parent-session' },
      telemetryFactory,
    });

    await telemetry.recordError(HARNESS_EVENT.configLoadFailed, new Error('private config path'), {
      'harness.layer': 'copilot',
      'harness.path': '/private/config.yaml',
    });

    expect(telemetryFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'doom-pi',
        packageName: '@agimon-ai/doompi',
        cwd: '/workspace',
        enableLogs: true,
        enableTraces: true,
        headers: {
          'x-agent': 'doom-pi',
          'x-agent-session-id': expect.stringMatching(/^id_[0-9a-f]+$/),
          'x-agent-parent-session-id': expect.stringMatching(/^id_[0-9a-f]+$/),
        },
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(HARNESS_EVENT.configLoadFailed, {
      attributes: {
        'telemetry.package': '@agimon-ai/doompi',
        'harness.layer': 'copilot',
        'error.type': 'Error',
        outcome: 'error',
      },
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private config path');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('/private/config.yaml');
  });

  it('records lifecycle events and deduplicates repeated failures', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createHarnessTelemetry({ telemetryFactory });
    const error = new Error('same failure');

    await telemetry.recordError(HARNESS_EVENT.launchFailed, error, { 'harness.exit_code': 1 });
    await telemetry.recordError(HARNESS_EVENT.launchFailed, error, { 'harness.exit_code': 1 });
    await telemetry.recordEvent(HARNESS_EVENT.launchCompleted, { 'harness.exit_code': 0 });

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('runs load-bearing launch stages exactly once when tracing fails', async () => {
    const { telemetry, telemetryFactory } = createTelemetryDouble();
    vi.mocked(telemetry.runInSpan).mockRejectedValue(new Error('tracer unavailable'));
    const reporter = createHarnessTelemetry({ telemetryFactory });
    const callback = vi.fn(async () => 'launched');

    await expect(reporter.runInSpan('doom_pi.run', {}, callback)).resolves.toBe('launched');
    expect(callback).toHaveBeenCalledOnce();
  });

  it('buffers startup spans and events until telemetry flushes', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const reporter = createHarnessTelemetry({ telemetryFactory, deferSpans: true });
    const callback = vi.fn(async () => 'launched');

    await expect(reporter.runInSpan('doom_pi.run', {}, callback)).resolves.toBe('launched');
    expect(telemetryFactory).not.toHaveBeenCalled();

    await reporter.recordEvent(HARNESS_EVENT.projectTrustResolved);
    expect(telemetryFactory).not.toHaveBeenCalled();

    await reporter.flush();
    expect(telemetryFactory).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('keeps telemetry failures out of the launcher', async () => {
    const warn = vi.fn();
    const reporter = createHarnessTelemetry({
      telemetryFactory: vi.fn(async () => {
        throw new Error('sink unavailable');
      }),
      warn,
    });

    await expect(reporter.recordEvent(HARNESS_EVENT.launchCompleted)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('flushes and shuts down initialized telemetry', async () => {
    const { telemetry, telemetryFactory } = createTelemetryDouble();
    const reporter = createHarnessTelemetry({ telemetryFactory });

    await reporter.recordEvent(HARNESS_EVENT.launchCompleted);
    await reporter.flush();
    await reporter.shutdown();

    expect(telemetry.flush).toHaveBeenCalled();
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it('adapts async failures to the synchronous launcher hooks', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const reporter = createHarnessTelemetry({ telemetryFactory });
    const failureReporter = toFailureReporter(reporter);

    failureReporter.warn(HARNESS_EVENT.hookFailed, new Error('hook failed'));
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());
  });
});
