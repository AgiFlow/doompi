import { defineResource } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
type HeadlessExecution = NonNullable<DoomServerPluginContext['agent']>['context'];
export default defineResource({
  name: 'doompi/domain-config',
  kind: 'context' as const,
  read: (execution: HeadlessExecution) => JSON.stringify({ domains: execution.selection.domains }),
});
