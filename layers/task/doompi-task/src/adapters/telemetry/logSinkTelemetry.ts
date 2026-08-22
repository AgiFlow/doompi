import { createDoomTelemetry, type DoomTelemetry, type DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import { TASK_EVENT, type TaskErrorAttributes, type TaskFailureReporter } from '../../types/telemetry.ts';

export {
  TASK_EVENT,
  type TaskErrorAttributes,
  type TaskErrorSink,
  type TaskEventName,
  type TaskEventSink,
  type TaskFailureReporter,
} from '../../types/telemetry.ts';

const SERVICE_NAME = 'doom-task';
const PACKAGE_NAME = '@agimon-ai/doompi-task';
const NOTIFICATION_OPERATION = 'completion_notification';

export interface TaskErrorReporterOptions {
  cwd?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  telemetryFactory?: NonNullable<DoomTelemetryOptions['telemetryFactory']>;
  warn?: (message: string) => void;
}

export interface TaskErrorReporter {
  recordError(event: string, error: unknown, attributes?: TaskErrorAttributes): Promise<void>;
  recordWarning(event: string, error: unknown, attributes?: TaskErrorAttributes): Promise<void>;
  recordEvent(event: string, attributes?: TaskErrorAttributes): Promise<void>;
  recordNotificationError(error: unknown, taskId: number): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createTaskErrorReporter(options: TaskErrorReporterOptions = {}): TaskErrorReporter {
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
    recordNotificationError: (error, taskId) =>
      telemetry.recordError(TASK_EVENT.notificationFailed, error, {
        'task.id': taskId,
        'task.operation': NOTIFICATION_OPERATION,
      }),
    flush: () => telemetry.flush(),
    shutdown: () => telemetry.shutdown(),
  };
}

export function toFailureReporter(reporter: TaskErrorReporter): TaskFailureReporter {
  return {
    error: (event, error, attributes) => void reporter.recordError(event, error, attributes),
    warn: (event, error, attributes) => void reporter.recordWarning(event, error, attributes),
    event: (event, attributes) => void reporter.recordEvent(event, attributes),
  };
}
