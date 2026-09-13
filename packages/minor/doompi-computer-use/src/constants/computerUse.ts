export const COMPUTER_USE_GUIDANCE = `[COMPUTER USE ACTIVE]
Use computer_state before acting and after any action that may change the interface. Use only element refs and snapshot ids returned by computer_state. Use computer_action for one semantic press, focus, set_value, or scroll at a time. Use computer_exec only for a trusted, explicitly allowed local TypeScript script. Never infer coordinates, inspect another application, bypass secure elements, or retry an uncertain outcome. Stop computer use when the task is complete.`;
export const COMMAND_NAME = 'computer-use';
export const COMMAND_DESCRIPTION = 'Inspect or manage the session computer use mode';

export const COMPUTER_USE_TOOL_NAMES = ['computer_state', 'computer_action', 'computer_exec'] as const;
