import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { COMMAND_NAME } from '../../../../../../constants/task';
import { reducerAction } from '../../../../../../services/taskTool';
import type { TaskServerScope } from '../../_lib/root.server';

export default (context: WithRoot<DoomServerPluginContext, TaskServerScope>) => ({
  name: COMMAND_NAME,
  description: 'List or clear the persistent task graph.',
  async execute(args: string, commandContext: DoomHeadlessExecutionContext) {
    const action = args.trim() === 'clear' ? 'clear' : 'list';
    const response = await reducerAction(context.root.store, action, { action }, context.root.maxTasks);
    const content = response.content[0];
    await commandContext.client.notify({
      body: content?.type === 'text' ? content.text : 'No tasks',
      level: 'info',
    });
  },
});
