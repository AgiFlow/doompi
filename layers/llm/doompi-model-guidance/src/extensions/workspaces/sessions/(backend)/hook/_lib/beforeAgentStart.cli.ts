import fs from 'node:fs';
import path from 'node:path';

import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { applyModelGuidance, guidanceForModel } from '../../../../../../services/modelGuidance';
import { loadModelGuidance } from '../../../../../../services/modelGuidanceStore';

/** Read each turn so configuration edits take effect without restarting the session. */
export const modelGuidanceEvents = {
  before_agent_start(event, context) {
    const modelId = context.model?.id;
    if (!modelId) return undefined;
    let root = path.resolve(context.cwd);
    while (!fs.existsSync(path.join(root, '.git')) && !fs.existsSync(path.join(root, '.doom'))) {
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
    const guidance = guidanceForModel(loadModelGuidance(root), modelId);
    const systemPrompt = applyModelGuidance(event.systemPrompt, guidance);
    return systemPrompt ? { systemPrompt } : undefined;
  },
} satisfies PiEventHandlers;

export default (_context: PiPluginContext) =>
  (...args: Parameters<typeof modelGuidanceEvents.before_agent_start>) =>
    modelGuidanceEvents.before_agent_start(...args);
