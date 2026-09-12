import { PACKAGE_SOURCE } from '../constants/package';
import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { QuestionnaireCoordinator } from '../services/questionnaireCoordinator';
import { createAskUserHeadlessTool } from '../tools/askUserHeadless';
export const userFeedbackServerFacet = defineServerPlugin({
  name: PACKAGE_SOURCE,
  session: () => {
    const coordinator = new QuestionnaireCoordinator();
    return {
      tools: [createAskUserHeadlessTool(coordinator)],
      hooks: [{ event: 'session_shutdown', handle: () => coordinator.shutdown() }],
      onDispose: () => coordinator.shutdown(),
    };
  },
});
export default userFeedbackServerFacet;
