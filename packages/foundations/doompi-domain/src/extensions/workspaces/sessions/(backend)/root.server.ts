import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolvePluginEntries } from '@agimon-ai/doompi-config/domains';
import { loadHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import {
  DOOM_MCP_PROJECTION_RESOLVER_SERVICE,
  type DoomMcpProjectionResolverService,
} from '@agimon-ai/doompi-core/mcpProjection';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';
import type { Context } from '@deepseek-ai/cordis';

import { resolveMcpAllowlist } from '../../../../services/mcpFilter';
import { materializePluginEntries } from '../../../../services/pluginMaterializer';
import { stageMcpResources } from '../../../../services/resourceCollector';
import { domainServerResources } from './_lib/domainServerResources';
import type { DomainServerScope } from './_lib/serverScope';

export default defineRoot(async ({ agent }: DoomServerPluginContext) => {
  const services: Array<(cordis: Context) => void> = [];
  if (agent) {
    const execution = agent.context;
    const home = execution.environment.HOME ?? os.homedir();
    const resolver: DoomMcpProjectionResolverService = {
      async resolve(domains) {
        const { state } = loadHarnessState({ ...execution.environment });
        const directory = await mkdtemp(path.join(os.tmpdir(), 'doom-domain-mcp-'));
        try {
          const plugins = await materializePluginEntries(
            resolvePluginEntries(execution.repoRoot, [...domains], [...state.pluginDirectories], home),
          );
          const staged = await stageMcpResources(execution.repoRoot, plugins, {
            enabled: true,
            temporaryDirectory: directory,
            mcpAllowlist: resolveMcpAllowlist(execution.repoRoot, [...domains]),
          });
          return {
            projection: staged.mcpProjection,
            cleanup: () => rm(directory, { recursive: true, force: true }),
          };
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
      },
    };
    services.push((cordis) => {
      cordis.plugin((provider) => {
        provider.provide(DOOM_MCP_PROJECTION_RESOLVER_SERVICE, resolver);
      });
    });
  }
  return {
    value: { resources: agent ? await domainServerResources(agent.context) : [] } satisfies DomainServerScope,
    services,
  };
});
