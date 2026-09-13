import { createDoomTelemetry, type DoomTelemetry, type DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';

const SERVICE_NAME = 'doom-autocompact';
const PACKAGE_NAME = '@agimon-ai/doompi-autocompact';

export const AUTOCOMPACT_EVENT = {
  checkpointStarted: 'doom_autocompact.checkpoint_started',
  checkpointCompleted: 'doom_autocompact.checkpoint_completed',
  checkpointFailed: 'doom_autocompact.checkpoint_failed',
  checkpointInvalid: 'doom_autocompact.checkpoint_invalid',
  configurationLoadFailed: 'doom_autocompact.configuration_load_failed',
  contextContributionDegraded: 'doom_autocompact.context_contribution_degraded',
  contextCommitted: 'doom_autocompact.context_committed',
  contextApplied: 'doom_autocompact.context_applied',
  contextMarkerInvalid: 'doom_autocompact.context_marker_invalid',
  nativeCompactionCompleted: 'doom_autocompact.native_compaction_completed',
} as const;

export type AutocompactEventName = (typeof AUTOCOMPACT_EVENT)[keyof typeof AUTOCOMPACT_EVENT];
export type AutocompactEventAttributes = Record<string, string | number | boolean>;

export interface AutocompactTelemetryOptions {
  cwd?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  telemetryFactory?: NonNullable<DoomTelemetryOptions['telemetryFactory']>;
  warn?: (message: string) => void;
}

export interface AutocompactTelemetry {
  recordError(event: AutocompactEventName, error: unknown, attributes?: AutocompactEventAttributes): Promise<void>;
  recordWarning(event: AutocompactEventName, error: unknown, attributes?: AutocompactEventAttributes): Promise<void>;
  recordEvent(event: AutocompactEventName, attributes?: AutocompactEventAttributes): Promise<void>;
  runInSpan<T>(name: string, attributes: AutocompactEventAttributes, callback: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createAutocompactTelemetry(options: AutocompactTelemetryOptions = {}): AutocompactTelemetry {
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
    recordEvent: (event, attributes) => telemetry.recordEvent(event, attributes),
    runInSpan: (name, attributes, callback) => telemetry.runInSpan(name, attributes, callback),
    flush: () => telemetry.flush(),
    shutdown: () => telemetry.shutdown(),
  };
}
