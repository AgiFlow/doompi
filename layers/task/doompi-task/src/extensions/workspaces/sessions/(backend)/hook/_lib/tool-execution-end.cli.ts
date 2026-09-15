import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { TaskPiScope } from '../../_lib/root.cli';

export default (context: WithRoot<PiPluginContext, TaskPiScope>) => context.root.toolExecutionEnd;
