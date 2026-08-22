import type { DoomTelemetry } from '@agimon-ai/doompi-telemetry';

export const EXTENSION_ERROR_EVENT = 'doom_team.extension_error';

export interface ExtensionHookFailure {
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
}

function extensionName(extensionPath: string): string {
  return extensionPath.split(/[\\/]/u).at(-1) ?? extensionPath;
}

export function createExtensionHookError(failure: ExtensionHookFailure): Error {
  const error = new Error(
    JSON.stringify({
      thrownValue: failure.error,
      extensionPath: failure.extensionPath,
      hookOperation: failure.event,
    }),
  );
  error.name = 'ExtensionHookError';
  if (failure.stack) error.stack = failure.stack;
  return error;
}

export function recordNonBlockingExtensionError(
  telemetry: Pick<DoomTelemetry, 'recordError'> | undefined,
  failure: ExtensionHookFailure,
): void {
  if (!telemetry) return;

  const error = createExtensionHookError(failure);
  void telemetry
    .recordError(
      EXTENSION_ERROR_EVENT,
      error,
      {
        'extension.name': extensionName(failure.extensionPath),
        'extension.operation': failure.event,
        'failure.kind': 'extension',
        'failure.scope': 'non_blocking',
        runtime: 'sdk',
      },
      { includeException: true },
    )
    .catch(() => undefined);
}
