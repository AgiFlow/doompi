import { defineRoot } from '@agimon-ai/doompi-core/extension-file';

import { mountMcpTools } from '../../../../services/mcpTools';
import runtime from './_lib/index.server';

export default defineRoot((context: Parameters<typeof runtime>[0]) => {
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
