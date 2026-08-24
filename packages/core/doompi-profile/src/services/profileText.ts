import type { AgentProfile } from '@agimon-ai/doompi-config/profiles';
import type { SelectItem } from '@earendil-works/pi-tui';

const NONE = '(none)';

/** Footer status key the cockpit's profile axis reads. */
export const PROFILE_STATUS_KEY = 'doom-profile';

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
