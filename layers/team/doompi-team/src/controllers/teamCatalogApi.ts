import type { DoomApi, DoomApiHandler } from '@agimon-ai/doompi-core/package-api';

import { AgentDiscoveryService, resolveActiveTeamModelSpecs } from '../services/agentDiscovery';
import { catalogModels, presentCatalog, type CatalogAgentInput } from '../services/webSubagentCatalog';

export const TEAM_API_BASE_PATH = 'team';
export const TEAM_CATALOG_ROUTE = '/catalog';

export interface TeamCatalogSnapshot {
  agents: CatalogAgentInput[];
  models: string[];
}

export interface TeamCatalogApiOptions {
  cwd: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  read?: (cwd: string) => TeamCatalogSnapshot;
}

/** Serves catalog discovery from the session process, which owns the active domain environment. */
export function createTeamCatalogApi(options: TeamCatalogApiOptions): DoomApiHandler {
  const discovery = new AgentDiscoveryService(options.environment);
  const read =
    options.read ??
    ((cwd: string): TeamCatalogSnapshot => ({
      agents: discovery.discover(cwd, 'both').agents,
      models: resolveActiveTeamModelSpecs(options.environment) ?? [],
    }));

  return {
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.pathname !== TEAM_CATALOG_ROUTE) {
        return Response.json({ error: 'Not found.' }, { status: 404 });
      }
      try {
        discovery.invalidate();
        const snapshot = read(options.cwd);
        return Response.json({
          cwd: options.cwd,
          agents: presentCatalog(snapshot.agents),
          models: catalogModels(snapshot.agents, snapshot.models),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 500 });
      }
    },
    close: () => undefined,
  };
}

/** Session package API entry loaded by doompi-server. */
export const api: DoomApi = {
  basePath: TEAM_API_BASE_PATH,
  start(context) {
    if (!context.cwd || !context.environment) throw new Error('Team catalog requires an admitted session.');
    return createTeamCatalogApi({ cwd: context.cwd, environment: context.environment });
  },
};
