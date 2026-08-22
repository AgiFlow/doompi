import { createDoomTelemetry, type DoomTelemetry, type DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';

const SERVICE_NAME = 'doom-plan';
const PACKAGE_NAME = '@agimon-ai/doompi-plan';

export const PLAN_EVENT = {
  configLoadFailed: 'doom_plan.config_load_failed',
  writePlanFailed: 'doom_plan.write_plan_failed',
  writePlanTimedOut: 'doom_plan.write_plan_timed_out',
  writePlanUnsafePath: 'doom_plan.write_plan_unsafe_path',
  modelResolveFailed: 'doom_plan.model_resolve_failed',
  modeEnabled: 'doom_plan.mode_enabled',
  modeDisabled: 'doom_plan.mode_disabled',
  planWritten: 'doom_plan.plan_written',
  planReviewCompleted: 'doom_plan.plan_review_completed',
} as const;

export type PlanEventName = (typeof PLAN_EVENT)[keyof typeof PLAN_EVENT];
export type PlanEventAttributes = Record<string, string | number | boolean>;

export interface PlanTelemetryOptions {
  cwd?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  telemetryFactory?: NonNullable<DoomTelemetryOptions['telemetryFactory']>;
  warn?: (message: string) => void;
}

export interface PlanTelemetry {
  recordError(event: PlanEventName, error: unknown, attributes?: PlanEventAttributes): Promise<void>;
  recordWarning(event: PlanEventName, error: unknown, attributes?: PlanEventAttributes): Promise<void>;
  recordEvent(event: PlanEventName, attributes?: PlanEventAttributes): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createPlanTelemetry(options: PlanTelemetryOptions = {}): PlanTelemetry {
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
