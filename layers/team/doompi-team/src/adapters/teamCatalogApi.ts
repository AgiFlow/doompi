import type { DoomApi, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import type { CatalogAgentInput } from '../services/webSubagentCatalog.ts';
import { AgentDiscoveryService, resolveActiveTeamModelSpecs } from './agents/discovery.ts';

export const TEAM_API_BASE_PATH = 'team';
export const TEAM_CATALOG_ROUTE = '/catalog';

export interface TeamCatalogSnapshot {
  agents: CatalogAgentInput[];
  models: string[];
}

export interface TeamCatalogApiOptions {
  cwd: string;
  read?: (cwd: string) => TeamCatalogSnapshot;
}

/** Serves catalog discovery from the session process, which owns the active domain environment. */
export function createTeamCatalogApi(options: TeamCatalogApiOptions): DoomApiHandler {
  const discovery = new AgentDiscoveryService();
  const read =
    options.read ??
    ((cwd: string): TeamCatalogSnapshot => ({
      agents: discovery.discover(cwd, 'both').agents,
      models: resolveActiveTeamModelSpecs() ?? [],
    }));

  return {
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.pathname !== TEAM_CATALOG_ROUTE) {
        return Response.json({ error: 'Not found.' }, { status: 404 });
      }
      try {
        return Response.json(read(options.cwd));
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
    return createTeamCatalogApi({ cwd: context.cwd ?? process.cwd() });
  },
};
