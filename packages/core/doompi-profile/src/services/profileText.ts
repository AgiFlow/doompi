import type { AgentProfile } from '@agimon-ai/doompi-config/profiles';
import type { SelectItem } from '@earendil-works/pi-tui';

const NONE = '(none)';

/** Footer status key the cockpit's profile axis reads. */
export const PROFILE_STATUS_KEY = 'doom-profile';

/** Identity this package registers voice capabilities under. */
export const PROFILE_SOURCE = '@agimon-ai/doompi-profile';

/** The command a queued voice switch invokes, and the reload handoff kind it parks. */
export const PROFILE_COMMAND = 'profile';
export const PROFILE_SWITCH_HANDOFF_KIND = 'profile-switch';
export const VOICE_SWITCH_TOKEN_PREFIX = '--voice-switch-token=';

/**
 * The published axis content: the active profile's name, empty while
 * profiles exist with none active, and undefined to withhold the status so
 * the cockpit keeps the axis off the bar entirely.
 */
export function profileStatus(current: string | undefined, hasProfiles: boolean): string | undefined {
  if (current) return current;
  return hasProfiles ? '' : undefined;
}

/** Rows for the single-select profile picker. */
export function profileItems(profiles: AgentProfile[]): SelectItem[] {
  return profiles.map((profile) => ({
    value: profile.name,
    label: profile.name,
    description: profileDescription(profile),
  }));
}

export function profileDescription(profile: AgentProfile): string {
  const environmentKeys = Object.keys(profile.env).sort();
  return environmentKeys.length > 0 ? `${profile.persona} (env: ${environmentKeys.join(', ')})` : profile.persona;
}

/** Shown when the picked profile is already active. */
export function profileSummary(profile: AgentProfile): string {
  const environmentKeys = Object.keys(profile.env).sort();
  return [
    `Profile ${profile.name}`,
    `Persona: ${profile.persona}`,
    `Env: ${environmentKeys.join(', ') || NONE}`,
    'Already loaded.',
  ].join('\n');
}

export function profileTitle(current?: string): string {
  return `Profile (current: ${current ?? NONE})`;
}

/**
 * The opaque token a voice switch hands to the follow-up command invocation.
 *
 * The profile name is deliberately absent from the command text, so an edited
 * transcript cannot be turned into a switch to a different persona.
 */
export function voiceSwitchToken(args: string): string | undefined {
  const trimmed = args.trim();
  if (!trimmed.startsWith(VOICE_SWITCH_TOKEN_PREFIX)) return undefined;

  const parts = trimmed.split(/\s+/u);
  if (parts.length !== 1) throw new Error('The voice profile switch token must be the only command argument.');
  const token = parts[0]?.slice(VOICE_SWITCH_TOKEN_PREFIX.length).trim();
  if (!token) throw new Error('The voice profile switch token is missing.');
  return token;
}
