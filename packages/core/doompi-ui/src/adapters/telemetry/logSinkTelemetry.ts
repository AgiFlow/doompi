import { createDoomTelemetry, type DoomTelemetry, type DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';

const SERVICE_NAME = 'doom-pi-ui';
const PACKAGE_NAME = '@agimon-ai/doompi-ui';

export const UI_EVENT = {
  leaderContributionRejected: 'doom_pi_ui.leader_contribution_rejected',
  leaderCommandUnavailable: 'doom_pi_ui.leader_command_unavailable',
  leaderActionUnavailable: 'doom_pi_ui.leader_action_unavailable',
  themeApplyFailed: 'doom_pi_ui.theme_apply_failed',
  shellInstalled: 'doom_pi_ui.shell_installed',
} as const;

export type UiEventName = (typeof UI_EVENT)[keyof typeof UI_EVENT];
export type UiEventAttributes = Record<string, string | number | boolean>;

export interface UiTelemetryOptions {
  cwd?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  telemetryFactory?: NonNullable<DoomTelemetryOptions['telemetryFactory']>;
  warn?: (message: string) => void;
}

export interface UiTelemetry {
  recordError(event: UiEventName, error: unknown, attributes?: UiEventAttributes): Promise<void>;
  recordWarning(event: UiEventName, error: unknown, attributes?: UiEventAttributes): Promise<void>;
  recordEvent(event: UiEventName, attributes?: UiEventAttributes): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createUiTelemetry(options: UiTelemetryOptions = {}): UiTelemetry {
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
    flush: () => telemetry.flush(),
    shutdown: () => telemetry.shutdown(),
  };
}
