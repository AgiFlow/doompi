/**
 * Which contribution field each surface produces, per host and side.
 *
 * The surface names the concept; the host decides which array carries it.
 * A surface missing from a host's table is legitimately absent there, such
 * as api/ on the CLI, and is skipped without complaint.
 *
 * Two hosts read the frontend side. The cockpit takes the `.web` files; the
 * terminal takes only the `.cli` ones, and puts them somewhere else, which is
 * why that side needs a table per host rather than one shared.
 */

/** A surface that produces nothing registrable, but is still published. */
export const NOT_A_CONTRIBUTION = '';

/**
 * A surface whose file is folded into another contribution rather than being one.
 *
 * A terminal tool renderer is not a separate registration the way a cockpit
 * one is: `renderCall` and `renderResult` are fields of the tool declaration,
 * so the generated entry pairs the presentation file with the backend tool of
 * the same name and merges them.
 */
export const MERGED_INTO_TOOL = 'tool-renderers';

export const CLI_FIELDS: Readonly<Record<string, string>> = {
  tool: 'tools',
  'tool-restriction': 'toolRestrictions',
  command: 'commands',
  shortcut: 'shortcuts',
  hook: 'events',
  provider: 'providers',
  resource: 'resources',
};

export const SERVER_FIELDS: Readonly<Record<string, string>> = {
  tool: 'tools',
  'tool-restriction': 'toolRestrictions',
  command: 'commands',
  hook: 'hooks',
  mode: 'minorModes',
  api: 'api',
  channel: 'channels',
  method: 'methods',
  resource: 'resources',
};

export const MCP_FIELDS: Readonly<Record<string, string>> = {
  tool: 'tools',
  skill: 'skills',
  resource: 'uiResources',
};
/** The terminal's own presentation surfaces, authored under `(frontend)` with a `.cli` suffix. */
export const CLI_FRONTEND_FIELDS: Readonly<Record<string, string>> = {
  tool: MERGED_INTO_TOOL,
  message: 'messageRenderers',
  overlay: NOT_A_CONTRIBUTION,
};

export const WEB_FIELDS: Readonly<Record<string, string>> = {
  tool: 'toolRenderers',
  command: 'paletteCommands',
  mode: 'minorModes',
  channel: 'channels',
  tab: 'tabs',
  template: 'templates',
  dock: 'dockFaces',
  setting: 'settingsSections',
  slot: 'slots',
  // Every fill is a slot fill. The cockpit declares its own regions as slots
  // (overlay, rail, context, activity and so on), so the build tooling needs
  // to know none of their names.
  fill: 'fills',
  action: 'contextActions',
  'activity-group': 'activityGroups',
  leader: 'leaderBindings',
  'selection-axis': 'selectionAxes',
  lifecycle: 'start',
  'file-links': 'fileLinks',
  'repository-settings-panel': 'repositorySettingsPanel',
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
