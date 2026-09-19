import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { mountMcpTools } from '../../../../services/mcpTools';
import runtime from './_lib/runtime.server';

export default defineRoot((context: DoomServerPluginContext) => {
  const value = runtime(context);
  return {
    value,
    services: [...(value.services ?? []), ...(value.tools?.length ? [mountMcpTools(value.tools)] : [])],
    activities: value.activities,
    onStart: value.onStart,
    onStop: value.onStop,
    onDispose: value.onDispose,
  };
});
