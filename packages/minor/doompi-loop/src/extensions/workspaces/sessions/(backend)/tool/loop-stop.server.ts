import { defineTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import type { LoopToolsRoot } from '../../../../../services/loopTools/type';

export default defineTool((context: WithRoot<unknown, LoopToolsRoot>) => context.root.loopTools[2]!);
