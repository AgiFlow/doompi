import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createSkillRuntime } from './_lib/skillRuntime';
export default defineRoot(({ pi }: PiPluginContext) => {
  const runtime = createSkillRuntime({
    pi,
    openOverlay: async (context, options) =>
      (await import('../../../../tui/skillsOverlay')).openSkillsOverlay(context, options),
  });
  return { value: runtime, services: runtime.services, onStop: runtime.onStop, onDispose: runtime.onDispose };
});
