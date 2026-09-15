import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createMajorModeServerCommand } from '../../../../controllers/majorModeServerCommand';
import { readPackageResource } from '../../../../services/packageResources';

type HeadlessExecution = NonNullable<DoomServerPluginContext['agent']>['context'];

export default ({ agent }: DoomServerPluginContext) => ({
  commands: agent ? [createMajorModeServerCommand(agent)] : [],
  resources: [
    {
      name: 'doompi/modes-config',
      kind: 'context' as const,
      read: (execution: HeadlessExecution) =>
        JSON.stringify({ majorMode: execution.selection.majorMode, activeLayers: execution.selection.activeLayers }),
    },
    {
      name: 'doompi/model',
      kind: 'context' as const,
      read: (execution: HeadlessExecution) => JSON.stringify(execution.model ?? null),
    },
    {
      name: 'doompi-author-major-mode',
      kind: 'skill' as const,
      read: () => readPackageResource('src/prompts/doompi-author-major-mode/SKILL.md'),
    },
  ],
});
