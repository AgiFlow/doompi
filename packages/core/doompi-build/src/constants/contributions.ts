/**
 * Which contribution field each surface produces, per host.
 *
 * The surface names the concept; the host decides which array carries it.
 * A surface missing from a host's table is legitimately absent there, such
 * as api/ on the CLI, and is skipped without complaint.
 */

/** A surface that produces nothing registrable, but is still published. */
export const NOT_A_CONTRIBUTION = '';

export const CLI_FIELDS: Readonly<Record<string, string>> = {
  tool: 'tools',
  command: 'commands',
  hook: 'events',
  service: 'services',
  mode: 'minorModes',
};

export const SERVER_FIELDS: Readonly<Record<string, string>> = {
  tool: 'tools',
  command: 'commands',
  hook: 'hooks',
  service: 'services',
  mode: 'minorModes',
  api: 'api',
  channel: 'channels',
  method: 'methods',
  activity: 'activities',
};

export const WEB_FIELDS: Readonly<Record<string, string>> = {
  tool: 'toolRenderers',
  command: 'paletteCommands',
  mode: 'minorModes',
  channel: 'channels',
  tab: 'tabs',
  dock: 'dockFaces',
  setting: 'settingsSections',
  slot: 'slots',
  fill: 'fills',
  action: 'contextActions',
  api: NOT_A_CONTRIBUTION,
  method: NOT_A_CONTRIBUTION,
  store: NOT_A_CONTRIBUTION,
};

/**
 * Host regions a fill may name, and the array each one is read from.
 *
 * The cockpit registry is already slot-keyed internally and most of these
 * desugar into it at install time, so one `fill/` folder can stand in for all
 * of them. `activity` is the exception the generator must keep separate: its
 * binding resolves late, against the set of installed activity groups.
 */
export const FILL_FIELDS: Readonly<Record<string, string>> = {
  activity: 'activitySections',
  context: 'contextSections',
  rail: 'railSections',
  overlay: 'overlays',
  'selection-bar': 'selectionBarItems',
  'composer-actions': 'composerActions',
  'composer-menu': 'composerMenuItems',
};

/** The fill target whose binding resolves after every activity group is known. */
export const ACTIVITY_FILL_TARGET = 'activity';

/** Disambiguates the two shapes a `setting/` file can take. */
export const SETTING_FIELDS: Readonly<Record<string, string>> = {
  section: 'settingsSections',
  panel: 'settingsPanels',
};

/** Disambiguates the two shapes an `action/` file can take. */
export const ACTION_FIELDS: Readonly<Record<string, string>> = {
  context: 'contextActions',
  message: 'userMessageActions',
};
