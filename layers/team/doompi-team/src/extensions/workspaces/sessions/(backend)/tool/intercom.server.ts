import { defineServerTool, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { NativeTeamRuntime } from '../../../../../services/nativeTeamChannel';
import type { TeamServerScope } from '../_lib/root.server';

function intercomTool(channel: NativeTeamRuntime): DoomHeadlessTool {
  return {
    name: 'intercom',
    label: 'Intercom',
    description: 'Communicate with active agents in this root session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['members', 'send', 'ask', 'pending', 'reply'] },
        to: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
      required: ['action'],
    },
    executionMode: 'serial',
    async execute(toolCallId, parameters, signal, onUpdate) {
      return channel.execute(toolCallId, parameters, signal, onUpdate);
    },
  };
}

export default defineServerTool((context: WithRoot<DoomServerPluginContext, TeamServerScope>) =>
  intercomTool(context.root.channel),
);
