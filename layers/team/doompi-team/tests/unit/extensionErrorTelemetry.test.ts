import { describe, expect, it, vi } from 'vitest';

import {
  createExtensionHookError,
  EXTENSION_ERROR_EVENT,
  recordNonBlockingExtensionError,
  type ExtensionHookFailure,
} from '../../src/services/runs/extensionErrorTelemetry';

const failure: ExtensionHookFailure = {
  extensionPath: '/workspace/.pi/extensions/repositoryHooks.mjs',
  event: 'agent_end',
  error: 'repository update failed',
  stack: 'Error: repository update failed\n    at updateRepository (repositoryHooks.mjs:42:7)',
};

describe('extension error telemetry', () => {
  it('serializes the thrown value, extension path, hook operation, and original stack', () => {
    const error = createExtensionHookError(failure);

    expect(error.name).toBe('ExtensionHookError');
    expect(JSON.parse(error.message)).toEqual({
      thrownValue: failure.error,
      extensionPath: failure.extensionPath,
      hookOperation: failure.event,
    });
    expect(error.stack).toBe(failure.stack);
  });

  it('records a distinct non-blocking extension failure with exception details enabled', () => {
    const recordError = vi.fn(async () => undefined);

    const result = recordNonBlockingExtensionError({ recordError }, failure);

    expect(result).toBeUndefined();
    expect(recordError).toHaveBeenCalledOnce();
    expect(recordError).toHaveBeenCalledWith(
      EXTENSION_ERROR_EVENT,
      expect.objectContaining({ name: 'ExtensionHookError', stack: failure.stack }),
      {
        'extension.name': 'repositoryHooks.mjs',
        'extension.operation': 'agent_end',
        'failure.kind': 'extension',
        'failure.scope': 'non_blocking',
        runtime: 'sdk',
      },
      { includeException: true },
    );
  });

  // Every built Doom extension entry is named pi.mjs, so without the owning package the sink
  // cannot say which extension failed. Three headless-child failures were recorded as bare
  // 'pi.mjs' and were undiagnosable for exactly this reason.
  it('names the owning package for a Doom extension whose entry basename is shared', () => {
    const recordError = vi.fn(async () => undefined);

    recordNonBlockingExtensionError(
      { recordError },
      { ...failure, extensionPath: '/repo/packages/minor/doompi-plan/dist/adapters/pi/pi.mjs' },
    );

    expect(recordError).toHaveBeenCalledWith(
      EXTENSION_ERROR_EVENT,
      expect.anything(),
      expect.objectContaining({ 'extension.name': 'pi.mjs', 'extension.package': 'doompi-plan' }),
      { includeException: true },
    );
  });

  it('names the owning package for a layer extension', () => {
    const recordError = vi.fn(async () => undefined);

    recordNonBlockingExtensionError(
      { recordError },
      { ...failure, extensionPath: '/repo/layers/team/doompi-team/dist/adapters/pi/pi.mjs' },
    );

    expect(recordError).toHaveBeenCalledWith(
      EXTENSION_ERROR_EVENT,
      expect.anything(),
      expect.objectContaining({ 'extension.package': 'doompi-team' }),
      { includeException: true },
    );
  });

  it('does not turn telemetry transport rejection into a job failure', async () => {
    const recordError = vi.fn(async () => Promise.reject(new Error('telemetry unavailable')));

    expect(() => recordNonBlockingExtensionError({ recordError }, failure)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(recordError).toHaveBeenCalledOnce();
  });
});
