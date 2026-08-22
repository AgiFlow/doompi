import type { AgentProfile } from '@agimon-ai/doompi-config/profiles';
import type { SelectItem } from '@earendil-works/pi-tui';

const NONE = '(none)';

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
