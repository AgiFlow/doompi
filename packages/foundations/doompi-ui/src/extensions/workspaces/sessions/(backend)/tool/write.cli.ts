import { defineCliTool } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext, PiToolDeclaration } from '@agimon-ai/doompi-core/piExtension';

import type { UiPiScope } from '../_lib/piScope';
export default defineCliTool((context: WithRoot<PiPluginContext<unknown>, UiPiScope>): PiToolDeclaration => {
  const tool = context.root.tools.find((candidate) => candidate.name === 'write');
  if (!tool) throw new Error('Missing built-in write tool.');
  return { ...tool, overrides: context.root.runtime.mode !== 'composed' };
});
