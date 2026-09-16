import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import { definePiToolRenderer, type PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { TaskStore } from '../../../../../../services/taskStore';
import { renderTaskCall, renderTaskResult } from '../../_shared/format.cli';

/** Pair the tool presentation with the same session store used by execution. */
export default (context: WithRoot<PiPluginContext, { taskStore: TaskStore }>) =>
  definePiToolRenderer({
    renderShell: 'self',
    renderCall: (params, theme) => renderTaskCall(params as never, theme, context.root.taskStore.snapshot.tasks),
    renderResult: renderTaskResult,
  });
