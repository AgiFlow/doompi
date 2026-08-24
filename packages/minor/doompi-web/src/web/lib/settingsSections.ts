/**
 * The settings menu, as data: the rail's gear and the settings page both
 * need to name a section, and neither feature may import the other.
 */
export interface SettingsSection {
  id: string;
  label: string;
  detail: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'providers', label: 'providers', detail: 'sign in to the model providers Pi can use' },
  { id: 'appearance', label: 'appearance', detail: 'pick the theme the cockpit renders with' },
];

export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0].id;

export function settingsSection(id: string | undefined): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}
