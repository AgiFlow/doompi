import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createRecentPrompts } from '../../../../../models/recentPrompts';
import { promptLeaderService } from '../../../../../services/promptLeader';
import { createNodeSavedPromptStore } from '../../../../../services/promptStore';
import type { PromptExtensionDependencies } from '../../../../../types/prompt';
export const createPromptPiRoot = ({ options }: PiPluginContext<PromptExtensionDependencies>) => ({
  value: options ?? { store: createNodeSavedPromptStore(), recent: createRecentPrompts() },
  services: [promptLeaderService],
});
export type PromptPiScope = Awaited<ReturnType<typeof createPromptPiRoot>>['value'];
