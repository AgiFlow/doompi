import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { createAutocompactRuntime, type AutocompactDependencies } from '../services/autocompactRuntime';
export const autocompactExtension = definePiExtension<AutocompactDependencies>(
  '@agimon-ai/doompi-autocompact',
  ({ pi, options }) => {
    const runtime = createAutocompactRuntime(pi, options);
    return { services: [runtime.plugin], events: runtime.events, onStop: runtime.stop };
  },
);
export default autocompactExtension;
