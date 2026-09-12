import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { createPromptSaveCommand } from '../controllers/promptSaveCommand';
import { createPromptsCommand } from '../controllers/promptsCommand';
import { createInputCapture } from '../controllers/inputCapture';
import { createRecentPrompts } from '../models/recentPrompts';
import { createNodeSavedPromptStore } from '../services/promptStore';
import { promptLeaderService } from '../services/promptLeader';
import type { PromptExtensionDependencies } from '../types/prompt';
import { PACKAGE_SOURCE, PROMPT_HELP_SKILL } from '../constants/prompt';
export const activatePromptExtension = definePiExtension<PromptExtensionDependencies>(PACKAGE_SOURCE, ({ options }) => {
  const dependencies = options ?? { store: createNodeSavedPromptStore(), recent: createRecentPrompts() };
  return {
    services: [promptLeaderService],
    events: { input: createInputCapture(dependencies.recent) },
    commands: [createPromptsCommand(dependencies), createPromptSaveCommand(dependencies)],
    resources: [{ source: PACKAGE_SOURCE, moduleUrl: import.meta.url, skills: [PROMPT_HELP_SKILL] }],
  };
});
export default activatePromptExtension;
