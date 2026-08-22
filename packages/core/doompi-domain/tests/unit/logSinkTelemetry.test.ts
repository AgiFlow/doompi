import type { DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import { describe, expect, it, vi } from 'vitest';
import { createDomainTelemetry } from '../../src/adapters/telemetry/logSinkTelemetry.ts';
import { DOMAIN_EVENT } from '../../src/types/telemetry.ts';

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

describe('domain telemetry', () => {
  it('reports under its own service and package name', async () => {
    const { telemetryFactory } = createTelemetryDouble();
    const telemetry = createDomainTelemetry({ cwd: '/workspace', env: {}, telemetryFactory });

    await telemetry.recordEvent(DOMAIN_EVENT.domainsSwitched, { 'harness.domains': 'development' });

    expect(telemetryFactory).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: 'doom-pi-domain', packageName: '@agimon-ai/doompi-domain' }),
    );
  });

  it('records a failed switch without throwing out of the command', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createDomainTelemetry({ cwd: '/workspace', env: {}, telemetryFactory });

    await telemetry.recordError(DOMAIN_EVENT.domainsSwitchFailed, new Error('bad yaml'));

    expect(logger.error).toHaveBeenCalled();
  });
});
