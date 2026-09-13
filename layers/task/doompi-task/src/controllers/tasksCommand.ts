import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { COMMAND_NAME, ERR_REQUIRES_INTERACTIVE } from '../schemas/task';
import type { TaskStore } from '../services/taskStore';

/**
 * `/tasks`, reachable from the leader palette as `SPC t l`.
 *
 * The command opens the Task Space overlay rather than printing a listing: the
 * overlay is the readable surface and it can edit, while a transcript dump could
 * only be read.
 */
export function createTasksCommand(
  store: TaskStore,
  openTaskSpace: (context: ExtensionContext, options: { store: TaskStore }) => Promise<void>,
  waitUntilReady?: (context: ExtensionContext) => Promise<void>,
): readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]] {
  return [
    COMMAND_NAME,
    {
      description: 'Open Task Space for this session tree',
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify(ERR_REQUIRES_INTERACTIVE, 'error');
          return;
        }

        await waitUntilReady?.(ctx);
        store.read();
        await openTaskSpace(ctx, { store });
      },
    },
  ];
}
