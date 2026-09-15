import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createAutocompactRuntime, type AutocompactDependencies } from '../../../../../services/autocompactRuntime';

export const createAutocompactPiRoot = ({ pi, options }: PiPluginContext) => {
  const runtime = createAutocompactRuntime(pi, options as unknown as AutocompactDependencies | undefined);
  return { value: runtime, services: [runtime.plugin], onStop: runtime.stop };
};
export type AutocompactScope = Awaited<ReturnType<typeof createAutocompactPiRoot>>['value'];
