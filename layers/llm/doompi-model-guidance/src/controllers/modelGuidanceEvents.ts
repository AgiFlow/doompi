import { getHarnessState } from '@agimon-ai/doompi-config';
import type { PiEventHandlers } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import { applyModelGuidance, guidanceForModel } from '../services/modelGuidance';
import { loadModelGuidance } from '../services/modelGuidanceStore';

/** Read each turn so configuration edits take effect without restarting the session. */
export const modelGuidanceEvents = {
  before_agent_start(event, context) {
    const modelId = context.model?.id;
    if (!modelId) return undefined;
    const guidance = guidanceForModel(loadModelGuidance(getHarnessState().root), modelId);
    const systemPrompt = applyModelGuidance(event.systemPrompt, guidance);
    return systemPrompt ? { systemPrompt } : undefined;
  },
} satisfies PiEventHandlers;
