import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { LIST_COMMAND_NAME, START_COMMAND_NAME } from '../schemas/loopCommands.ts';

const START_COMMAND_DESCRIPTION = 'Start a registered loop';
const LIST_COMMAND_DESCRIPTION = 'List and stop active loops';

export interface LoopCommandHandlers {
  start(ctx: ExtensionContext): Promise<void>;
  list(ctx: ExtensionContext): Promise<void>;
}

export function registerCommands(pi: ExtensionAPI, handlers: LoopCommandHandlers): void {
  pi.registerCommand(START_COMMAND_NAME, {
    description: START_COMMAND_DESCRIPTION,
    handler: async (_args, ctx) => handlers.start(ctx),
  });
  pi.registerCommand(LIST_COMMAND_NAME, {
    description: LIST_COMMAND_DESCRIPTION,
    handler: async (_args, ctx) => handlers.list(ctx),
  });
}
