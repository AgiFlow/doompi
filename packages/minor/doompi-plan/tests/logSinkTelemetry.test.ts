import type { DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import { describe, expect, it, vi } from 'vitest';
import { createPlanTelemetry, PLAN_EVENT } from '../src/exports/logSinkTelemetry';

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
  } as unknown as TelemetryHandle;
  const telemetryFactory = vi.fn(async () => telemetry);
  return { logger, telemetry, telemetryFactory };
}

describe('plan telemetry', () => {
  it('records sanitized errors with stable service metadata', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createPlanTelemetry({
      cwd: '/workspace',
      env: { AGENT_SESSION_ID: 'agent-session', PARENT_AGENT_SESSION_ID: 'parent-session' },
      telemetryFactory,
    });

    await telemetry.recordError(PLAN_EVENT.configLoadFailed, new Error('private config path'), {
      'plan.trigger': 'command',
      'plan.path': '/private/config.yaml',
    });

    expect(telemetryFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'doom-plan',
        packageName: '@agimon-ai/doompi-plan',
        cwd: '/workspace',
        enableLogs: true,
        enableTraces: true,
        headers: {
          'x-agent': 'doom-plan',
          'x-agent-session-id': expect.stringMatching(/^id_[0-9a-f]+$/),
          'x-agent-parent-session-id': expect.stringMatching(/^id_[0-9a-f]+$/),
        },
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(PLAN_EVENT.configLoadFailed, {
      attributes: {
        'telemetry.package': '@agimon-ai/doompi-plan',
        'plan.trigger': 'command',
        'error.type': 'Error',
        outcome: 'error',
      },
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private config path');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('/private/config.yaml');
  });

  it('records lifecycle events without an exception payload', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createPlanTelemetry({ telemetryFactory });

    await telemetry.recordEvent(PLAN_EVENT.planWritten, { 'plan.bytes': 1024, 'plan.outcome': 'written' });

    expect(logger.info).toHaveBeenCalledWith(PLAN_EVENT.planWritten, {
      attributes: {
        'telemetry.package': '@agimon-ai/doompi-plan',
        'plan.bytes': 1024,
        'plan.outcome': 'written',
      },
    });
  });

  it('deduplicates repeated failures while preserving distinct attributes', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createPlanTelemetry({ telemetryFactory });
    const error = new Error('same failure');

    await telemetry.recordError(PLAN_EVENT.writePlanFailed, error, { 'plan.phase': 'writing' });
    await telemetry.recordError(PLAN_EVENT.writePlanFailed, error, { 'plan.phase': 'writing' });
    await telemetry.recordError(PLAN_EVENT.writePlanFailed, error, { 'plan.phase': 'checking' });

    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('keeps telemetry failures out of the planning path', async () => {
    const warn = vi.fn();
    const telemetry = createPlanTelemetry({
      telemetryFactory: vi.fn(async () => {
        throw new Error('sink unavailable');
      }),
      warn,
    });

    await expect(telemetry.recordEvent(PLAN_EVENT.modeEnabled)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('flushes and shuts down initialized telemetry', async () => {
    const { telemetry, telemetryFactory } = createTelemetryDouble();
    const reporter = createPlanTelemetry({ telemetryFactory });

    await reporter.recordEvent(PLAN_EVENT.modeEnabled);
    await reporter.flush();
    await reporter.shutdown();

    expect(telemetry.flush).toHaveBeenCalled();
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
  });
});
