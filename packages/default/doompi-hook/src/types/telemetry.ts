import type { HOOK_TELEMETRY_EVENT } from '../constants/telemetry';
/** Telemetry events this package reports, and the port that records them. */

export type HookTelemetryEventName = (typeof HOOK_TELEMETRY_EVENT)[keyof typeof HOOK_TELEMETRY_EVENT];
export type HookTelemetryAttributes = Record<string, string | number | boolean>;

/**
 * A hook that never ran is indistinguishable from one that passed, which is why
 * both a failed run and an unreadable registry are worth reporting rather than
 * swallowing.
 */
export interface HookTelemetry {
  recordError(event: HookTelemetryEventName, error: unknown, attributes?: HookTelemetryAttributes): Promise<void>;
  recordWarning(event: HookTelemetryEventName, error: unknown, attributes?: HookTelemetryAttributes): Promise<void>;
}
