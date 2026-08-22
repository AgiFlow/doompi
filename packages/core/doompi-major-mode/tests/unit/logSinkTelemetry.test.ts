import type { DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import { describe, expect, it, vi } from 'vitest';
import { createMajorModeTelemetry } from '../../src/adapters/telemetry/logSinkTelemetry.ts';
import { MAJOR_MODE_EVENT } from '../../src/types/telemetry.ts';

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

describe('major mode telemetry', () => {
  it('reports under its own service and package name', async () => {
    const { telemetryFactory } = createTelemetryDouble();
    const telemetry = createMajorModeTelemetry({ cwd: '/workspace', env: {}, telemetryFactory });

    await telemetry.recordEvent(MAJOR_MODE_EVENT.majorModeSwitched, { 'harness.major_mode': 'minimal' });

    expect(telemetryFactory).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: 'doom-pi-major-mode', packageName: '@agimon-ai/doompi-major-mode' }),
    );
  });

  it('records a load failure without throwing out of the command', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createMajorModeTelemetry({ cwd: '/workspace', env: {}, telemetryFactory });

    await telemetry.recordError(MAJOR_MODE_EVENT.majorModeUnavailable, new Error('bad yaml'));

    expect(logger.error).toHaveBeenCalled();
  });
});
