import { createDoomTelemetry, type DoomTelemetry, type DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import type { ProfileTelemetry } from '../../types/telemetry.ts';

const SERVICE_NAME = 'doom-pi-profile';
const PACKAGE_NAME = '@agimon-ai/doompi-profile';

export interface ProfileTelemetryOptions {
  cwd?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  telemetryFactory?: NonNullable<DoomTelemetryOptions['telemetryFactory']>;
  warn?: (message: string) => void;
}

export function createProfileTelemetry(options: ProfileTelemetryOptions = {}): ProfileTelemetry {
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
    recordEvent: (event, attributes) => telemetry.recordEvent(event, attributes),
  };
}
