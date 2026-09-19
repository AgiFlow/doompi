import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';

import { TeamToolParamsSchema, type NativeTeamRuntime } from '../nativeTeamChannel';

export function createHeadlessIntercomTool(channel: NativeTeamRuntime): DoomHeadlessTool<typeof TeamToolParamsSchema> {
  return {
    name: 'intercom',
    label: 'Intercom',
    description: 'Communicate with active agents in this root session.',
    parameters: TeamToolParamsSchema,
    promptGuidelines: [
      'Send only new progress, blockers, or decisions. Do not repeat task briefs or delegation instructions.',
    ],
    executionMode: 'serial',
    async execute(toolCallId, parameters, signal, onUpdate) {
      return channel.execute(toolCallId, parameters, signal, onUpdate);
    },
  };
}
