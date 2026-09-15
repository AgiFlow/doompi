import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { openTaskSpace } from '../../../(frontend)/overlay/_lib/task-space.cli';
import { COMMAND_NAME, ERR_REQUIRES_INTERACTIVE } from '../../../../../../schemas/task';
import type { TaskStore } from '../../../../../../services/taskStore';
import type { TaskPiScope } from '../../_lib/root.cli';

export default (context: WithRoot<PiPluginContext, TaskPiScope>) =>
  createTasksCommand(context.root.taskStore, openTaskSpace, context.root.waitForSessionReadiness);

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
