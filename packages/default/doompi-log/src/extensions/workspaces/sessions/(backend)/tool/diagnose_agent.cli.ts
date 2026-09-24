import { defineTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import type { LogPiScope } from '../_lib/piRoot';

export default defineTool((context: WithRoot<unknown, LogPiScope>) => context.root.diagnosticTool);
