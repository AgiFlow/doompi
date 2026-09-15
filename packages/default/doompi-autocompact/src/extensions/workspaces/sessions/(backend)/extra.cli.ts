import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createAutocompactRuntime, type AutocompactDependencies } from '../../../../services/autocompactRuntime';

export default ({ pi, options }: PiPluginContext) => {
  const runtime = createAutocompactRuntime(pi, options as unknown as AutocompactDependencies | undefined);
  return { services: [runtime.plugin], events: runtime.events, onStop: runtime.stop };
};
