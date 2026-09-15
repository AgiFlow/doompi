import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createPromptsCommand } from '../../../../../services/promptsCommand';
import type { PromptPiScope } from '../_lib/piRoot';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, PromptPiScope>) => [createPromptsCommand(context.root)] as const,
  { cardinality: 'many' },
);
