import type { SettingsSectionContribution } from '@agimon-ai/doompi-web-contracts';
import {
  pluginRepositorySettingsPanels,
  pluginSettingsPanels,
  pluginSettingsSections,
  type InstalledRepositorySettingsPanel,
  type InstalledSettingsPanel,
} from './pluginRegistry.ts';

/**
 * The settings menu, as data: the rail's gear and the settings page both
 * need to name a section, and neither feature may import the other.
 *
 * The host's own pages come first and keep fixed positions, because they
 * are about the cockpit itself rather than about a package. Contributed pages
 * sort after them, by their declared order and then their id, so the menu is
 * stable across syncs whatever order plugins install in.
 */
export type SettingsWorkspace = 'general' | 'repository';

export interface SettingsSection {
  id: string;
  label: string;
  detail: string;
  workspace: SettingsWorkspace;
  /** The fields a contributed page renders; absent on the host's own pages. */
  contribution?: SettingsSectionContribution;
  /** Package panel hosted inside the repository workspace. */
  repositoryPanel?: InstalledRepositorySettingsPanel;
  /** A page the contributing package draws itself, rather than fields the host renders. */
  panel?: InstalledSettingsPanel;
}

const GENERAL_SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'providers',
    label: 'providers',
    detail: 'sign in to the model providers Pi can use',
    workspace: 'general',
  },
  {
    id: 'appearance',
    label: 'appearance',
    detail: 'pick the theme the cockpit renders with',
    workspace: 'general',
  },
  {
    id: 'notifications',
    label: 'notifications',
    detail: 'allow live session notifications in this browser',
    workspace: 'general',
  },
  {
    id: 'images',
    label: 'images',
    detail: 'how large an image may be when it reaches a model',
    workspace: 'general',
  },
  {
    id: 'remote',
    label: 'remote control',
    detail: 'save a named tunnel for remote access',
    workspace: 'general',
  },
  {
    id: 'plugins',
    label: 'plugins',
    detail: 'the web plugins this bundle carries and what their install resolved',
    workspace: 'general',
  },
];

const REPOSITORY_DEFAULTS_SECTION: SettingsSection = {
  id: 'repositories',
  label: 'defaults',
  detail: 'mode, domains, and profile',
  workspace: 'repository',
};

const DEFAULT_CONTRIBUTED_ORDER = 1000;

/** Repository-workspace copies need their own route id, since the id is the route param. */
const REPOSITORY_SECTION_PREFIX = 'repository-';

export const DEFAULT_SETTINGS_SECTION = GENERAL_SETTINGS_SECTIONS[0]!.id;
export const DEFAULT_REPOSITORY_SETTINGS_SECTION = REPOSITORY_DEFAULTS_SECTION.id;

interface MenuOrdered {
  id: string;
  order?: number;
}

function byMenuOrder(left: MenuOrdered, right: MenuOrdered): number {
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
export function settingsSections(workspace?: SettingsWorkspace): readonly SettingsSection[] {
  const contributions = [...pluginSettingsSections()].sort(byMenuOrder);
  // The same page is offered in both workspaces. Scope comes from the workspace
  // the reader is in, so the general copy edits the global file and the
  // repository copy edits whichever repository the workspace picker holds.
  const contributed = contributions.map((contribution) => ({
    id: contribution.id,
    label: contribution.label,
    detail: contribution.detail,
    workspace: 'general' as const,
    contribution,
  }));
  const contributedForRepository = contributions.map((contribution) => ({
    id: `${REPOSITORY_SECTION_PREFIX}${contribution.id}`,
    label: contribution.label,
    detail: contribution.detail,
    workspace: 'repository' as const,
    contribution,
  }));
  // A self-drawn page has no scope to switch: it reports rather than writes,
  // so it appears once, in the general workspace, and not as a repository copy.
  const panels = [...pluginSettingsPanels()].sort(byMenuOrder).map((panel) => ({
    id: panel.id,
    label: panel.label,
    detail: panel.detail,
    workspace: 'general' as const,
    panel,
  }));
  const repositoryPanels = pluginRepositorySettingsPanels().map((repositoryPanel) => ({
    id: `${REPOSITORY_SECTION_PREFIX}${repositoryPanel.pluginId}`,
    label: repositoryPanel.label,
    detail: repositoryPanel.detail,
    workspace: 'repository' as const,
    repositoryPanel,
  }));
  const all = [
    ...GENERAL_SETTINGS_SECTIONS,
    ...contributed,
    ...panels,
    REPOSITORY_DEFAULTS_SECTION,
    ...repositoryPanels,
    ...contributedForRepository,
  ];
  return workspace === undefined ? all : all.filter((section) => section.workspace === workspace);
}

export function settingsSection(id: string | undefined): SettingsSection | undefined {
  return settingsSections().find((section) => section.id === id);
}
