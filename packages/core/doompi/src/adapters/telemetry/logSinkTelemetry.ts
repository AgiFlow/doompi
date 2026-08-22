import type { DoomTelemetry, DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';

const SERVICE_NAME = 'doom-pi';
const PACKAGE_NAME = '@agimon-ai/doompi';

export const HARNESS_EVENT = {
  cliFailed: 'doom_pi.cli_failed',
  contextBuildFailed: 'doom_pi.context_build_failed',
  resourceCollectionFailed: 'doom_pi.resource_collection_failed',
  configLoadFailed: 'doom_pi.config_load_failed',
  launchFailed: 'doom_pi.launch_failed',
  compatibilityLaunchFailed: 'doom_pi.compatibility_launch_failed',
  harnessStateParseFailed: 'doom_pi.harness_state_parse_failed',
  hookFailed: 'doom_pi.hook_failed',
  hookRegistryReadFailed: 'doom_pi.hook_registry_read_failed',
  personaReadFailed: 'doom_pi.persona_read_failed',
  styleSystemRenderFailed: 'doom_pi.style_system_render_failed',
  majorModeUnavailable: 'doom_pi.major_mode_unavailable',
  profileLoadFailed: 'doom_pi.profile_load_failed',
  launchCompleted: 'doom_pi.launch_completed',
  projectTrustResolved: 'doom_pi.project_trust_resolved',
  majorModeSwitched: 'doom_pi.major_mode_switched',
  profileApplied: 'doom_pi.profile_applied',
} as const;

export type HarnessEventName = (typeof HARNESS_EVENT)[keyof typeof HARNESS_EVENT];
export type HarnessEventAttributes = Record<string, string | number | boolean>;
export type HarnessErrorSink = (event: HarnessEventName, error: unknown, attributes?: HarnessEventAttributes) => void;

export interface HarnessFailureReporter {
  error: HarnessErrorSink;
  warn: HarnessErrorSink;
}

export interface HarnessTelemetryOptions {
  cwd?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  telemetryFactory?: NonNullable<DoomTelemetryOptions['telemetryFactory']>;
  warn?: (message: string) => void;
  /** Run startup callbacks before loading the telemetry backend. */
  deferSpans?: boolean;
}

export interface HarnessTelemetry {
  recordError(event: HarnessEventName, error: unknown, attributes?: HarnessEventAttributes): Promise<void>;
  recordWarning(event: HarnessEventName, error: unknown, attributes?: HarnessEventAttributes): Promise<void>;
  recordEvent(event: HarnessEventName, attributes?: HarnessEventAttributes): Promise<void>;
  runInSpan<T>(name: string, attributes: HarnessEventAttributes, callback: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createHarnessTelemetry(options: HarnessTelemetryOptions = {}): HarnessTelemetry {
  let telemetryPromise: Promise<DoomTelemetry> | undefined;
  const pendingEvents: Array<{ event: HarnessEventName; attributes?: HarnessEventAttributes }> = [];
  const telemetry = (): Promise<DoomTelemetry> => {
    telemetryPromise ??= import('@agimon-ai/doompi-telemetry').then(({ createDoomTelemetry }) =>
      createDoomTelemetry({
        serviceName: SERVICE_NAME,
        packageName: PACKAGE_NAME,
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot,
        env: options.env,
        telemetryFactory: options.telemetryFactory,
        warn: options.warn,
        enableLogs: true,
        enableTraces: true,
      }),
    );
    return telemetryPromise;
  };
  const drainEvents = async (loaded: DoomTelemetry): Promise<void> => {
    for (const pending of pendingEvents.splice(0)) {
      await loaded.recordEvent(pending.event, pending.attributes);
    }
  };
  return {
    recordError: async (event, error, attributes) => {
      const loaded = await telemetry();
      await drainEvents(loaded);
      await loaded.recordError(event, error, attributes);
    },
    recordWarning: async (event, error, attributes) => {
      const loaded = await telemetry();
      await drainEvents(loaded);
      await loaded.recordWarning(event, error, attributes);
    },
    recordEvent: async (event, attributes) => {
      if (options.deferSpans && !telemetryPromise) {
        pendingEvents.push({ event, attributes });
        return;
      }
      await (await telemetry()).recordEvent(event, attributes);
    },
    runInSpan: (name, attributes, callback) => {
      // The launcher opts into this path for pre-spawn preparation. Lifecycle
      // events remain buffered until flush; failures still initialize the real
      // sink immediately so diagnostics are not lost.
      if (options.deferSpans && !telemetryPromise) return callback();
      return telemetry().then((loaded) => loaded.runInSpan(name, attributes, callback));
    },
    flush: async () => {
      if (!telemetryPromise && pendingEvents.length === 0) return;
      const loaded = await telemetry();
      await drainEvents(loaded);
      await loaded.flush();
    },
    shutdown: async () => {
      if (!telemetryPromise && pendingEvents.length === 0) return;
      const loaded = await telemetry();
      await drainEvents(loaded);
      await loaded.shutdown();
    },
  };
}

export function toFailureReporter(telemetry: HarnessTelemetry): HarnessFailureReporter {
  return {
    error: (event, error, attributes) => void telemetry.recordError(event, error, attributes),
    warn: (event, error, attributes) => void telemetry.recordWarning(event, error, attributes),
  };
}
