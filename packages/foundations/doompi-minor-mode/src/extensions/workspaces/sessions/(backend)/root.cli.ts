import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createMinorModePiRuntime } from './_lib/catalogRuntime';
export default defineRoot(({ pi }: PiPluginContext) => {
  const runtime = createMinorModePiRuntime(pi);
  return { value: runtime, services: runtime.services, onStop: runtime.onStop, onDispose: runtime.onDispose };
});
