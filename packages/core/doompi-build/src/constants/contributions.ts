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
  // Every fill is a slot fill. The cockpit declares its own regions as slots
  // (overlay, rail, context, activity and so on), so the build tooling needs
  // to know none of their names.
  fill: 'fills',
  action: 'contextActions',
  api: NOT_A_CONTRIBUTION,
  method: NOT_A_CONTRIBUTION,
  store: NOT_A_CONTRIBUTION,
};

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
