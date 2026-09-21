import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';

import { authorMinorMode } from '../../../../models/authorMode';
import { createAuthorCatalog } from '../../../../services/authorCatalog';
import { api, createAuthorSessionApi } from './api/author/_lib/authorApi';

export default defineRoot(({ agent }: DoomServerPluginContext) => {
  const session = agent ? createAuthorSessionApi(agent.context.cwd, agent.context.sessionId) : undefined;
  const mode = agent
    ? authorMinorMode.createOwner({
        isActive: () => (agent.context.selection.state?.['minor-mode'] ?? []).includes(authorMinorMode.descriptor.id),
        detail: () => 'document authoring available',
        async setActive(enabled) {
          const modes = (agent.context.selection.state?.['minor-mode'] ?? []).filter(
            (id) => id !== authorMinorMode.descriptor.id,
          );
          await agent.changeSelection({
            axis: 'state',
            key: 'minor-mode',
            values: enabled ? [...modes, authorMinorMode.descriptor.id] : modes,
          });
        },
      })
    : undefined;
  return {
    value: {
      api: session?.api ?? api,
      catalog: createAuthorCatalog(session?.catalog),
      assertAvailable: () => undefined,
      service: undefined,
    },
    services: mode ? [serverMinorModes([mode])] : [],
  };
});
