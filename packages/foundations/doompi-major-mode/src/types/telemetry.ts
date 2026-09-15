/** Telemetry events this package reports, and the port that records them. */
export const MAJOR_MODE_EVENT = {
  majorModeSwitched: 'doom_pi_major_mode.switched',
  majorModeUnavailable: 'doom_pi_major_mode.unavailable',
} as const;

export type MajorModeEventName = (typeof MAJOR_MODE_EVENT)[keyof typeof MAJOR_MODE_EVENT];
export type MajorModeEventAttributes = Record<string, string | number | boolean>;

export interface MajorModeTelemetry {
  recordError(event: MajorModeEventName, error: unknown, attributes?: MajorModeEventAttributes): Promise<void>;
  recordEvent(event: MajorModeEventName, attributes?: MajorModeEventAttributes): Promise<void>;
}
