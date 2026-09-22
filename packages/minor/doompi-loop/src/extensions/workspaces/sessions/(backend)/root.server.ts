import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import runtime from './_lib/runtime.server';

export default defineRoot((context: DoomServerPluginContext) => {
  const value = runtime(context);
  return {
    value,
    services: value.services,
    activities: value.activities,
    onStart: value.onStart,
    onStop: value.onStop,
    onDispose: value.onDispose,
  };
});
