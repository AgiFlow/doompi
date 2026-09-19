import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessToolRestriction,
} from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';
import type { Context } from '@deepseek-ai/cordis';

import { AUTHOR_FACADE_TOOL_NAMES } from '../../../../constants/author';
import { authorMinorMode } from '../../../../models/authorMode';
import { createAuthorCatalog } from '../../../../services/authorCatalog';
import { createAuthorTools } from '../../../../services/authorTools';
import { mountMcpTools } from '../../../../services/mcpTools';
import { OPEN_AUTHORING_FILE_TOOL_NAME } from '../../../../types/author';
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
  const restriction = (cordis: Context): void => {
    cordis.inject([DOOM_HEADLESS_HOST_SERVICE], (child) => {
      const host = requireDoomHeadlessHost(child);
      const declaration: DoomHeadlessToolRestriction = {
        when: { state: { 'minor-mode': 'author' } },
        allowedTools: [OPEN_AUTHORING_FILE_TOOL_NAME, ...AUTHOR_FACADE_TOOL_NAMES],
      };
      const handle = host.registerToolRestriction(declaration);
      child.effect(() => () => handle.dispose());
    });
  };

  const catalog = createAuthorCatalog(session?.catalog);
  const assertAvailable = () => undefined;
  return {
    value: {
      api: session?.api ?? api,
      catalog,
      assertAvailable,
      service: undefined,
    },
    services: [
      ...(mode ? [serverMinorModes([mode])] : []),
      restriction,
      mountMcpTools(createAuthorTools(catalog, assertAvailable)),
    ],
  };
});
