import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { HelpRuntimeOptions } from '../../../../services/helpRuntime';
import runtime from './_lib/runtime.cli';

export default defineRoot((context: PiPluginContext<HelpRuntimeOptions>) => {
  const value = runtime(context);
  return {
    value,
    services: value.services,
    onStart: value.onStart,
    onStop: value.onStop,
    onDispose: value.onDispose,
  };
});
