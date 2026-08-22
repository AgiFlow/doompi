import type { DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import { describe, expect, it, vi } from 'vitest';
import { createUiTelemetry, UI_EVENT } from '../src/exports/logSinkTelemetry.ts';

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

describe('ui telemetry', () => {
  it('records safe UI failures and hashes session headers', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createUiTelemetry({
      cwd: '/workspace',
      env: { AGENT_SESSION_ID: 'agent-session', AGENT_PARENT_SESSION_ID: 'parent-session' },
      telemetryFactory,
    });

    await telemetry.recordWarning(UI_EVENT.themeApplyFailed, new Error('private theme path'), {
      'ui.theme': 'doom-pi-dark',
      'ui.path': '/private/theme.json',
    });

    expect(telemetryFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'doom-pi-ui',
        packageName: '@agimon-ai/doompi-ui',
        headers: {
          'x-agent': 'doom-pi-ui',
          'x-agent-session-id': expect.stringMatching(/^id_[0-9a-f]+$/),
          'x-agent-parent-session-id': expect.stringMatching(/^id_[0-9a-f]+$/),
        },
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(UI_EVENT.themeApplyFailed, {
      attributes: {
        'telemetry.package': '@agimon-ai/doompi-ui',
        'ui.theme': 'doom-pi-dark',
        'error.type': 'Error',
        outcome: 'error',
      },
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private theme path');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('/private/theme.json');
  });

  it('records lifecycle events without exception payloads', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const telemetry = createUiTelemetry({ telemetryFactory });

    await telemetry.recordEvent(UI_EVENT.shellInstalled, { 'ui.theme': 'doom-pi-dark', 'ui.leader.group.count': 8 });

    expect(logger.info).toHaveBeenCalledWith(UI_EVENT.shellInstalled, {
      attributes: {
        'telemetry.package': '@agimon-ai/doompi-ui',
        'ui.theme': 'doom-pi-dark',
        'ui.leader.group.count': 8,
      },
    });
  });

  it('keeps sink failures out of UI paths', async () => {
    const warn = vi.fn();
    const telemetry = createUiTelemetry({
      telemetryFactory: vi.fn(async () => {
        throw new Error('sink unavailable');
      }),
      warn,
    });

    await expect(telemetry.recordEvent(UI_EVENT.shellInstalled)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('flushes and shuts down initialized telemetry', async () => {
    const { telemetry, telemetryFactory } = createTelemetryDouble();
    const reporter = createUiTelemetry({ telemetryFactory });

    await reporter.recordEvent(UI_EVENT.shellInstalled);
    await reporter.flush();
    await reporter.shutdown();

    expect(telemetry.flush).toHaveBeenCalled();
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
  });
});
