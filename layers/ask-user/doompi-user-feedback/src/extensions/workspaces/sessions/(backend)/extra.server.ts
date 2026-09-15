import type { DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';

import { QuestionnaireCoordinator } from '../../../../services/questionnaireCoordinator';
import { createAskUserHeadlessTool } from './_tools/askUserHeadless';

export default (): DoomServerSessionPlugin => {
  const coordinator = new QuestionnaireCoordinator();
  return {
    tools: [createAskUserHeadlessTool(coordinator)],
    hooks: [{ event: 'session_shutdown', handle: () => coordinator.shutdown() }],
    onDispose: () => coordinator.shutdown(),
  };
};
