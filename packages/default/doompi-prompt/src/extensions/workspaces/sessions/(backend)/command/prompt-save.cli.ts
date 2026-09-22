import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createPromptSaveCommand } from '../../../../../services/promptSaveCommand';
import type { PromptPiScope } from '../_lib/piRoot';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, PromptPiScope>) => [createPromptSaveCommand(context.root)] as const,
  { cardinality: 'many' },
);
