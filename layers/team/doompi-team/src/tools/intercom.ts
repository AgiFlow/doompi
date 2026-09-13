import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { NATIVE_TEAM_TOOL_NAME, TeamToolParamsSchema, type NativeTeamRuntime } from '../services/nativeTeamChannel';
export function createIntercomTool(
  runtime: NativeTeamRuntime,
  pi: Pick<ExtensionAPI, 'getAllTools'>,
  waitUntilReady: (context: ExtensionContext, signal?: AbortSignal) => Promise<void>,
): ToolDefinition<typeof TeamToolParamsSchema, Record<string, unknown>> {
  let conflict = false;
  try {
    conflict = pi.getAllTools().some((tool) => tool.name === NATIVE_TEAM_TOOL_NAME);
  } catch {
    /* Host discovery can be unavailable during installation. */
  }
  if (conflict)
    throw new Error(
      `[tool_conflict] A foreign '${NATIVE_TEAM_TOOL_NAME}' tool is already registered. Recovery: disable the competing extension and reload Doom Team.`,
    );
  return {
    name: NATIVE_TEAM_TOOL_NAME,
    label: 'Intercom',
    description:
      'Communicate with active native agents in this root session. Use members, send, ask, pending, or reply.',
    parameters: TeamToolParamsSchema,
    promptGuidelines: [
      'Send only new progress, blockers, or decisions. Do not repeat the task brief, sender task, or delegation instructions because the recipient already has them.',
    ],
    async execute(id, params, signal, onUpdate, context) {
      await waitUntilReady(context, signal);
      return runtime.execute(id, params, signal, onUpdate);
    },
  };
}
