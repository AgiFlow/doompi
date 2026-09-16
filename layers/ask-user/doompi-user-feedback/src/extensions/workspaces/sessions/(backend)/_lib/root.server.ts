import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { QuestionnaireCoordinator } from '../../../../../services/questionnaireCoordinator';

const root = defineRoot((_context: DoomServerPluginContext) => {
  const coordinator = new QuestionnaireCoordinator();
  return { value: { coordinator }, onDispose: () => coordinator.shutdown() };
});

export type UserFeedbackServerScope = Awaited<ReturnType<typeof root>>['value'];
export default root;
