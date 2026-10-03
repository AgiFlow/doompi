import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { createHookBinding } from '../../../../../services/hookRuntime';
import { createServerHooks } from '../../../../../services/serverHooks';

export const createHookServerRoot = ({ agent, signal }: DoomServerPluginContext) => {
  if (!agent) throw new Error('Hook session requires the headless host.');
  const execution = agent.context;
  const binding = createHookBinding({}, {
    sessionId: execution.sessionId,
    isSubagent: false,
    cwd: execution.cwd,
    repoRoot: execution.repoRoot,
    model: execution.model,
    async sendMessage(text, delivery) {
      if (!execution.session.admitPrompt) throw new Error('The session cannot admit a hook prompt.');
      await execution.session.admitPrompt(text, delivery);
    },
    appendCustomEntry: (type, data) => execution.session.appendCustomEntry(type, data),
  }, signal);
  return { value: createServerHooks(binding.runtime), services: [binding.plugin] };
};

export type HookServerScope = Awaited<ReturnType<typeof createHookServerRoot>>['value'];
