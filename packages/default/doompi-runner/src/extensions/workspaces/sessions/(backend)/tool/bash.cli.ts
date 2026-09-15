import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext, PiToolDeclaration } from '@agimon-ai/doompi-core/pi-extension';

import { createBashTool } from '../../../../../services/bashTool';
import type { RunnerPiScope } from '../_lib/piRoot';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, RunnerPiScope>): PiToolDeclaration =>
    createBashTool(context.root.bashTool),
  {},
);
