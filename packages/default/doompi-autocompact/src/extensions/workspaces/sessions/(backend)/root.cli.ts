import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createAutocompactRuntime, type AutocompactDependencies } from '../../../../services/autocompactRuntime';

const root = defineRoot(({ pi, options }: PiPluginContext) => {
  const runtime = createAutocompactRuntime(pi, options as unknown as AutocompactDependencies | undefined);
  return { value: runtime, services: [runtime.plugin], onStop: runtime.stop };
});
export type AutocompactScope = ReturnType<typeof root>['value'];
export default root;
