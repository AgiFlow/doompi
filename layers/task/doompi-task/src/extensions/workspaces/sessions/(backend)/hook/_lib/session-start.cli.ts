import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import type { TaskPiScope } from '../../_lib/root.cli';

export default (context: WithRoot<PiPluginContext, TaskPiScope>) => context.root.sessionStart;
