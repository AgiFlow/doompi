import { defineCliTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext, PiToolDeclaration } from '@agimon-ai/doompi-core/piExtension';

import { createBashTool } from '../../../../../services/bashTool';
import type { RunnerPiScope } from '../_lib/piRoot';
export default defineCliTool((context: WithRoot<PiPluginContext<unknown>, RunnerPiScope>): PiToolDeclaration =>
  createBashTool(context.root.bashTool),
);
