import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createConfigRuntime } from '../../../../services/configRuntime';
export default defineRoot(({ pi }: PiPluginContext) => {
  const runtime = createConfigRuntime(pi);
  return { value: runtime, services: [runtime.plugin] };
});
