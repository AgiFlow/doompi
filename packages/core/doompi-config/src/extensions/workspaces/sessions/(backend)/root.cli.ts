import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import { createConfigRuntime } from '../../../../services/configRuntime';
const root = defineRoot(({ pi }: PiPluginContext) => {
  const runtime = createConfigRuntime(pi);
  return { value: runtime, services: [runtime.plugin] };
});
export type ConfigPiScope = ReturnType<typeof root>['value'];
export default root;
