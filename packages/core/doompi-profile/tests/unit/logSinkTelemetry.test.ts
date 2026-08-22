import type { DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import { describe, expect, it, vi } from 'vitest';
import { createProfileTelemetry } from '../../src/adapters/telemetry/logSinkTelemetry.ts';
import { PROFILE_EVENT } from '../../src/types/telemetry.ts';

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

describe('profile telemetry', () => {
  it('reports under its own service and package name', async () => {
    const { telemetryFactory } = createTelemetryDouble();
    const telemetry = createProfileTelemetry({ cwd: '/workspace', env: {}, telemetryFactory });

    await telemetry.recordEvent(PROFILE_EVENT.profileApplied, { 'harness.profile': 'reviewer' });

    expect(telemetryFactory).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: 'doom-pi-profile', packageName: '@agimon-ai/doompi-profile' }),
    );
  });

  it('records a load failure without throwing out of the command', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createProfileTelemetry({ cwd: '/workspace', env: {}, telemetryFactory });

    await telemetry.recordError(PROFILE_EVENT.profileLoadFailed, new Error('bad yaml'));

    expect(logger.error).toHaveBeenCalled();
  });
});
