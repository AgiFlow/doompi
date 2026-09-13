import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { createMajorModeServerCommand } from '../controllers/majorModeServerCommand';
import { readPackageResource } from '../services/packageResources';
import { MAJOR_MODE_SOURCE } from '../types/majorMode';

export const majorModeServerFacet = defineServerPlugin({
  name: MAJOR_MODE_SOURCE,
  session: ({ agent }) => ({
    commands: agent ? [createMajorModeServerCommand(agent)] : [],
    resources: [
      {
        name: 'doompi/modes-config',
        kind: 'context',
        read: (execution) =>
          JSON.stringify({ majorMode: execution.selection.majorMode, activeLayers: execution.selection.activeLayers }),
      },
      { name: 'doompi/model', kind: 'context', read: (execution) => JSON.stringify(execution.model ?? null) },
      {
        name: 'doompi-author-major-mode',
        kind: 'skill',
        read: () => readPackageResource('src/prompts/doompi-author-major-mode/SKILL.md'),
      },
    ],
  }),
});
export default majorModeServerFacet;
