import { START_COMMAND_DESCRIPTION, LIST_COMMAND_DESCRIPTION } from '../constants/loop';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { LIST_COMMAND_NAME, START_COMMAND_NAME } from '../constants/loop';

import type { LoopCommandHandlers } from '../types/loopCommand';
export function createLoopCommands(
  handlers: LoopCommandHandlers,
): readonly (readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]])[] {
  return [
    [
      START_COMMAND_NAME,
      {
        description: START_COMMAND_DESCRIPTION,
        handler: async (args, ctx) => handlers.start(ctx, args),
      },
    ],
    [
      LIST_COMMAND_NAME,
      {
        description: LIST_COMMAND_DESCRIPTION,
        handler: async (_args, ctx) => handlers.list(ctx),
      },
    ],
  ];
}
