import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import runtime from './_lib/runtime.cli';

export default defineRoot((context: PiPluginContext<undefined>) => {
  const value = runtime(context);
  return {
    value,
    services: value.services,
    onDispose: value.onDispose,
  };
});
