import { defineRoot } from '@agimon-ai/doompi-core/extension-file';

import runtime from './_runtime/index.server';

export default defineRoot((context: Parameters<typeof runtime>[0]) => {
  const value = runtime(context);
  return {
    value,
    services: value.services,
    activities: value.activities,
    onStop: value.onStop,
    onDispose: value.onDispose,
  };
});
