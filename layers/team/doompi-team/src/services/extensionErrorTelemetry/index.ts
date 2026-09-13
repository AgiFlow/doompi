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

/**
 * Every built Doom extension entry is named `pi.mjs`, so the basename alone cannot say which
 * extension failed. The owning package directory can, and unlike the raw path it survives the
 * telemetry sanitizer: keys ending in `.package` are passed through only when the value is not
 * an absolute path, so a bare package name reaches the sink where a full path would be dropped.
 */
function extensionPackage(extensionPath: string): string | undefined {
  return /(?:packages|layers)[\\/][^\\/]+[\\/]([^\\/]+)/u.exec(extensionPath)?.[1];
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
  const owningPackage = extensionPackage(failure.extensionPath);
  void telemetry
    .recordError(
      EXTENSION_ERROR_EVENT,
      error,
      {
        'extension.name': extensionName(failure.extensionPath),
        ...(owningPackage === undefined ? {} : { 'extension.package': owningPackage }),
        'extension.operation': failure.event,
        'failure.kind': 'extension',
        'failure.scope': 'non_blocking',
        runtime: 'sdk',
      },
      { includeException: true },
    )
    .catch(() => undefined);
}
