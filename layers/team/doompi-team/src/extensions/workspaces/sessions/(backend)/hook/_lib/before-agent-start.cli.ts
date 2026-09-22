import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { loadConfig } from '../../../../../../services/config';
import {
  appendOrchestratorPrompt,
  shouldInjectOrchestratorPrompt,
} from '../../../../../../services/orchestratorPrompt';
import type { TeamPiScope } from '../../_lib/root.cli';

export default (context: WithRoot<PiPluginContext, TeamPiScope>) => (event: { systemPrompt?: string }) => {
  if (!context.root.isActive() || !shouldInjectOrchestratorPrompt(loadConfig().config)) return undefined;
  return { systemPrompt: appendOrchestratorPrompt(event.systemPrompt) };
};
