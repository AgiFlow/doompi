/** Telemetry events this package reports, and the port that records them. */
export const PROFILE_EVENT = {
  profileApplied: 'doom_pi_profile.applied',
  profileLoadFailed: 'doom_pi_profile.load_failed',
  personaReadFailed: 'doom_pi_profile.persona_read_failed',
} as const;

export type ProfileEventName = (typeof PROFILE_EVENT)[keyof typeof PROFILE_EVENT];
export type ProfileEventAttributes = Record<string, string | number | boolean>;

export interface ProfileTelemetry {
  recordError(event: ProfileEventName, error: unknown, attributes?: ProfileEventAttributes): Promise<void>;
  recordEvent(event: ProfileEventName, attributes?: ProfileEventAttributes): Promise<void>;
}
