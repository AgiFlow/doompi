export const HELP_COMMAND_NAME = 'doom-help';
export const HELP_COMMAND_DESCRIPTION = 'Toggle Help guidance and read-only support diagnostics';
export const HELP_MODE_ID = 'help';
export const HELP_PACKAGE_SOURCE = '@agimon-ai/doompi-help';
export const HELP_SKILL = {
  name: 'doompi-use-help',
  description:
    'Set up and debug DoomPi agents using installed package guidance and scoped, read-only diagnostics. Diagnose missing capabilities before proposing authorized repairs.',
} as const;
export const HELP_GUIDANCE =
  'Help mode is active. Read doompi-use-help, inspect the available diagnostics, and use the narrowest package guidance for the task. Diagnose before proposing changes. Help does not grant additional permissions.';
export const HELP_STATUS_TOOL_NAME = 'help_status';
export const HELP_STATUS_TOOL_DESCRIPTION =
  'Inspect active Help skills, diagnostic tools, contributor ownership, and unavailable contributions in this session. Read-only; does not change selection or permissions.';
export const HELP_STATUS_LIMIT = 128;
