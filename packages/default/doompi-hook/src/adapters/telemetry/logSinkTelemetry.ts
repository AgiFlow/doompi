import { createDoomTelemetry, type DoomTelemetry, type DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import type { HookTelemetry } from '../../types/telemetry.ts';

const SERVICE_NAME = 'doom-pi-hook';
const PACKAGE_NAME = '@agimon-ai/doompi-hook';

export interface HookTelemetryOptions {
  cwd?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  telemetryFactory?: NonNullable<DoomTelemetryOptions['telemetryFactory']>;
  warn?: (message: string) => void;
}

export function createHookTelemetry(options: HookTelemetryOptions = {}): HookTelemetry {
  const telemetry: DoomTelemetry = createDoomTelemetry({
    serviceName: SERVICE_NAME,
    packageName: PACKAGE_NAME,
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    env: options.env,
    telemetryFactory: options.telemetryFactory,
    warn: options.warn,
    enableLogs: true,
    enableTraces: true,
  });
  return {
    recordError: (event, error, attributes) => telemetry.recordError(event, error, attributes),
    recordWarning: (event, error, attributes) => telemetry.recordWarning(event, error, attributes),
  };
}
