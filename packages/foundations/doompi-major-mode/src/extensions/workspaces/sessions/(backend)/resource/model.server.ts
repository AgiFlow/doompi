import { defineResource } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
type Execution = NonNullable<DoomServerPluginContext['agent']>['context'];
export default defineResource({
  name: 'doompi/model',
  kind: 'context' as const,
  read: (execution: Execution) => JSON.stringify(execution.model ?? null),
});
