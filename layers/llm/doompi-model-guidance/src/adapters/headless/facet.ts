import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessHook,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { applyModelGuidance, guidanceForModel } from '../../services/modelGuidance.ts';
import { loadModelGuidance } from '../modelGuidanceStore.ts';
import { readFile } from 'node:fs/promises';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

async function readPackageResource(name: string): Promise<string> {
  try {
    return await readFile(new URL(name, PACKAGE_ROOT), 'utf8');
  } catch {
    return `(resource unavailable: ${name})`;
  }
}

export const modelGuidanceHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resources: DoomHeadlessResource[] = [
      { name: 'doompi-model-guidance', kind: 'context', read: () => readPackageResource('llms.txt') },
      {
        name: 'doompi-use-model-guidance',
        kind: 'skill',
        read: () => readPackageResource('src/prompts/doompi-use-model-guidance/SKILL.md'),
      },
      { name: 'doompi-model-guidance-readme', kind: 'context', read: () => readPackageResource('README.md') },
    ];
    const hook: DoomHeadlessHook = {
      event: 'before_agent_start',
      handle(event, execution) {
        const modelId = execution.model?.id;
        if (!modelId) return undefined;
        const guidance = guidanceForModel(loadModelGuidance(execution.cwd), modelId);
        const systemPrompt = applyModelGuidance(
          typeof event.systemPrompt === 'string' ? event.systemPrompt : '',
          guidance,
        );
        return systemPrompt ? { systemPrompt } : undefined;
      },
    };
    const registrations = [...resources.map((resource) => host.registerResource(resource)), host.registerHook(hook)];
    return () => registrations.forEach((registration) => registration.dispose());
  },
};

export default modelGuidanceHeadlessFacet;
