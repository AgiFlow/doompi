import type { DoomHeadlessHook } from '@agimon-ai/doompi-core/headless';
import { applyModelGuidance, guidanceForModel } from '../services/modelGuidance';
import { loadModelGuidance } from '../services/modelGuidanceStore';

export const modelGuidanceHook: DoomHeadlessHook = {
  event: 'before_agent_start',
  handle(event, execution) {
    const modelId = execution.model?.id;
    if (!modelId) return undefined;
    const guidance = guidanceForModel(loadModelGuidance(execution.cwd), modelId);
    const systemPrompt = applyModelGuidance(typeof event.systemPrompt === 'string' ? event.systemPrompt : '', guidance);
    return systemPrompt ? { systemPrompt } : undefined;
  },
};
