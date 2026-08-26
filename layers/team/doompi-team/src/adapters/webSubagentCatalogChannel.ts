import type { HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { type CatalogAgentInput, catalogModels, presentCatalog } from '../services/webSubagentCatalog.ts';
import { SUBAGENT_CATALOG_TYPE, type SubagentCatalogPayload } from '../types/webSubagents.ts';
import { AgentDiscoveryService, resolveActiveTeamModelSpecs } from './agents/discovery.ts';

/** Agent files change rarely; discovery's own cache makes each look cheap. */
const CATALOG_REFRESH_MS = 15_000;

/** Reads the launchable agents for one directory; injectable so a test needs no agent files on disk. */
export type CatalogReader = (cwd: string) => { agents: CatalogAgentInput[]; models: string[] };

export function defaultCatalogReader(): CatalogReader {
  const discovery = new AgentDiscoveryService();
  return (cwd) => ({
    agents: discovery.discover(cwd, 'both').agents,
    models: resolveActiveTeamModelSpecs() ?? [],
  });
}

/**
 * The subagent catalog data channel: what each managed session's directory
 * can launch, published as 'subagent_catalog' payloads. Discovery runs once
 * per session on arrival, again at every subscribe, and on a slow tick so an
 * agent file written while the page is open shows up without a reload. A
 * failed read publishes an empty list with the reason rather than nothing.
 */
export function createSubagentCatalogChannel(
  read: CatalogReader = defaultCatalogReader(),
  refreshMs = CATALOG_REFRESH_MS,
): WebHubChannel {
  return {
    frameType: SUBAGENT_CATALOG_TYPE,
    start(host) {
      const scopes = new Map<string, HubSessionScope>();
      const latest = new Map<string, string>();

      const compute = (scope: HubSessionScope): SubagentCatalogPayload => {
        try {
          const { agents, models } = read(scope.cwd);
          return { cwd: scope.cwd, agents: presentCatalog(agents), models: catalogModels(agents, models) };
        } catch (error) {
          const warning = error instanceof Error ? error.message : String(error);
          return { cwd: scope.cwd, agents: [], models: [], warning };
        }
      };

      /** Recomputes and remembers; publishes only what changed, so the tick stays quiet. */
      const refresh = (scope: HubSessionScope, publish: boolean): SubagentCatalogPayload => {
        const payload = compute(scope);
        const json = JSON.stringify(payload);
        if (latest.get(scope.sessionId) === json) return payload;
        latest.set(scope.sessionId, json);
        if (payload.warning !== undefined) {
          host.onNotice(`subagent catalog for ${scope.cwd} is unavailable (${payload.warning})`);
        }
        if (publish) host.publish(scope.sessionId, payload);
        return payload;
      };

      const timer = setInterval(() => {
        for (const scope of scopes.values()) refresh(scope, true);
      }, refreshMs);

      const source: HubChannelSource = {
        payloadFor(scope) {
          // The snapshot travels on its own, so a fresh read is remembered but not also published.
          return scopes.has(scope.sessionId) ? refresh(scope, false) : undefined;
        },
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          refresh(scope, true);
        },
        sessionRemoved(sessionId) {
          scopes.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          clearInterval(timer);
          scopes.clear();
          latest.clear();
        },
      };
      return source;
    },
  };
}
