import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext, PiToolDeclaration } from '@agimon-ai/doompi-core/pi-extension';

import type { UiPiScope } from '../_lib/piScope';
export default defineRoutedContribution((context: WithRoot<PiPluginContext<unknown>, UiPiScope>): PiToolDeclaration => {
  const tool = context.root.tools.find((candidate) => candidate.name === 'find');
  if (!tool) throw new Error('Missing built-in find tool.');
  return { ...tool, overrides: context.root.runtime.mode !== 'composed' };
}, {});
