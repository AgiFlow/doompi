import type { DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import { describe, expect, it, vi } from 'vitest';
import { createHookTelemetry } from '../../src/adapters/telemetry/logSinkTelemetry.ts';
import { HOOK_TELEMETRY_EVENT } from '../../src/types/telemetry.ts';

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
  return { logger, telemetryFactory: vi.fn(async () => telemetry) };
}

describe('hook telemetry', () => {
  it('reports under its own service and package name', async () => {
    const { telemetryFactory } = createTelemetryDouble();
    const telemetry = createHookTelemetry({ cwd: '/workspace', env: {}, telemetryFactory });

    await telemetry.recordError(HOOK_TELEMETRY_EVENT.hookRegistryReadFailed, new Error('bad yaml'));

    expect(telemetryFactory).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: 'doom-pi-hook', packageName: '@agimon-ai/doompi-hook' }),
    );
  });

  it('records a failed hook as a warning rather than an error', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createHookTelemetry({ cwd: '/workspace', env: {}, telemetryFactory });

    await telemetry.recordWarning(HOOK_TELEMETRY_EVENT.hookFailed, 'Hook timed out after 1 seconds.', {
      'hook.reason': 'timeout',
    });

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
