import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';

const SERVICE_NAME = 'doompi-server';
const PACKAGE_NAME = '@agimon-ai/doompi-server';

export type ServerTelemetry = Pick<
  DoomTelemetry,
  'recordEvent' | 'recordWarning' | 'recordError' | 'runInSpan' | 'flush' | 'shutdown'
>;

export function createServerTelemetry(
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    warn?: (message: string) => void;
  } = {},
): ServerTelemetry {
  return createDoomTelemetry({
    serviceName: SERVICE_NAME,
    packageName: PACKAGE_NAME,
    cwd: options.cwd,
    env: options.env,
    warn: options.warn,
    enableLogs: true,
    enableTraces: true,
  });
}

/** Telemetry is diagnostic and must never interrupt the server's critical path. */
export function observe(operation: Promise<unknown>, onNotice?: (message: string) => void): void {
  void operation.catch((error: unknown) =>
    onNotice?.(`telemetry failed: ${error instanceof Error ? error.message : String(error)}`),
  );
}
