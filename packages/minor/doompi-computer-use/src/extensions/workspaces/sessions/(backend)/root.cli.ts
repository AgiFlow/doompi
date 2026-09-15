import { defineRoot } from '@agimon-ai/doompi-core/extension-file';

import runtime from './_runtime/index.cli';

export default defineRoot((context: Parameters<typeof runtime>[0]) => {
  const value = runtime(context);
  return {
    value,
    services: value.services,

    onStop: value.onStop,
    onDispose: value.onDispose,
  };
});
