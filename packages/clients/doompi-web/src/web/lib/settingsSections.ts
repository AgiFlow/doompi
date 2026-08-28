import type { SettingsSectionContribution } from '@agimon-ai/doompi-web-contracts';
import { pluginSettingsSections } from './pluginRegistry.ts';

/**
 * The settings menu, as data: the rail's gear and the settings page both
 * need to name a section, and neither feature may import the other.
 *
 * The host's own three pages come first and keep fixed positions, because they
 * are about the cockpit itself rather than about a package. Contributed pages
 * sort after them, by their declared order and then their id, so the menu is
 * stable across syncs whatever order plugins install in.
 */
export interface SettingsSection {
  id: string;
  label: string;
  detail: string;
  /** The fields a contributed page renders; absent on the host's own pages. */
  contribution?: SettingsSectionContribution;
}

const HOST_SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'providers', label: 'providers', detail: 'sign in to the model providers Pi can use' },
  { id: 'appearance', label: 'appearance', detail: 'pick the theme the cockpit renders with' },
  { id: 'remote', label: 'remote control', detail: 'save a named tunnel for remote access' },
  { id: 'plugins', label: 'plugins', detail: 'the web plugins this bundle carries and what their install resolved' },
];

const DEFAULT_CONTRIBUTED_ORDER = 1000;

export const DEFAULT_SETTINGS_SECTION = HOST_SETTINGS_SECTIONS[0]!.id;

function byMenuOrder(left: SettingsSectionContribution, right: SettingsSectionContribution): number {
  return (
    (left.order ?? DEFAULT_CONTRIBUTED_ORDER) - (right.order ?? DEFAULT_CONTRIBUTED_ORDER) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Every page the menu offers. Read through a function rather than held in a
 * const: plugins install before the first render, but a module-level array
 * evaluated at import time would freeze the list before that happened.
 */
export function settingsSections(): readonly SettingsSection[] {
  const contributed = [...pluginSettingsSections()].sort(byMenuOrder).map((contribution) => ({
    id: contribution.id,
    label: contribution.label,
    detail: contribution.detail,
    contribution,
  }));
  return [...HOST_SETTINGS_SECTIONS, ...contributed];
}

export function settingsSection(id: string | undefined): SettingsSection | undefined {
  return settingsSections().find((section) => section.id === id);
}
