import os from 'node:os';
import type { HubChannelHost, HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { type CatalogAgentInput, catalogModels, presentCatalog } from '../services/webSubagentCatalog.ts';
import { SUBAGENT_CATALOG_TYPE, type SubagentCatalogPayload } from '../types/webSubagents.ts';
import { AgentDiscoveryService, resolveActiveTeamModelSpecs } from './agents/discovery.ts';
import { readSessionCatalogSnapshot } from './sessionCatalogSnapshot.ts';
import { TEAM_API_BASE_PATH, TEAM_CATALOG_ROUTE, type TeamCatalogSnapshot } from './teamCatalogApi.ts';

/** Agent files change rarely; discovery's own cache makes each look cheap. */
const CATALOG_REFRESH_MS = 15_000;

/** Injectable catalog read for tests and alternate hosts. Production reads through the session API. */
export type CatalogReader = (cwd: string) => TeamCatalogSnapshot | Promise<TeamCatalogSnapshot>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCatalogSnapshot(value: unknown): TeamCatalogSnapshot {
  if (
    !isRecord(value) ||
    !Array.isArray(value.agents) ||
    !value.agents.every(isRecord) ||
    !Array.isArray(value.models)
  ) {
    throw new Error('Session catalog API returned an invalid payload.');
  }
  return {
    agents: value.agents as unknown as CatalogAgentInput[],
    models: value.models.filter((model): model is string => typeof model === 'string'),
  };
}

/**
 * What the session itself published, when it is current for this scope.
 *
 * The session process is the only one that sees the active domain projection,
 * so its snapshot wins over anything this process could discover. A cwd that no
 * longer matches means the scope moved and the file is about to be rewritten.
 */
function readPublishedCatalog(scope: HubSessionScope): TeamCatalogSnapshot | undefined {
  const snapshot = readSessionCatalogSnapshot({
    sessionId: scope.sessionId,
    tmpdir: os.tmpdir(),
    uid: process.getuid?.(),
  });
  if (snapshot === undefined || snapshot.cwd !== scope.cwd) return undefined;
  return { agents: snapshot.agents, models: snapshot.models };
}

async function readSessionCatalog(
  host: HubChannelHost,
  scope: HubSessionScope,
  signal: AbortSignal,
  fallback: CatalogReader,
): Promise<TeamCatalogSnapshot> {
  const published = readPublishedCatalog(scope);
  if (published !== undefined) return published;
  const response = await host.requestSessionApi(scope, {
    basePath: TEAM_API_BASE_PATH,
    path: TEAM_CATALOG_ROUTE,
    method: 'GET',
    signal,
  });
  if (response.status === 404) return await fallback(scope.cwd);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const reason =
      isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${String(response.status)}`;
    throw new Error(`Session catalog API failed: ${reason}`);
  }
  return parseCatalogSnapshot(payload);
}

/**
 * The subagent catalog data channel: what each managed session can launch.
 *
 * The session publishes its own discovery into its scope directory, because it
 * is the only process holding the active domain projection and the harness
 * state behind the Team model policy. This channel prefers that snapshot, then
 * the session API, then local discovery, which sees project and user agents but
 * no domain-provided ones.
 */
export function createSubagentCatalogChannel(read?: CatalogReader, refreshMs = CATALOG_REFRESH_MS): WebHubChannel {
  return {
    frameType: SUBAGENT_CATALOG_TYPE,
    start(host) {
      const scopes = new Map<string, HubSessionScope>();
      const latestJson = new Map<string, string>();
      const latestPayload = new Map<string, SubagentCatalogPayload>();
      const generations = new Map<string, number>();
      const abort = new AbortController();
      const fallbackDiscovery = new AgentDiscoveryService();
      const fallback: CatalogReader = (cwd) => ({
        agents: fallbackDiscovery.discover(cwd, 'both').agents,
        models: resolveActiveTeamModelSpecs() ?? [],
      });
      let closed = false;

      const commit = (scope: HubSessionScope, generation: number, payload: SubagentCatalogPayload): void => {
        const active = scopes.get(scope.sessionId);
        if (closed || active?.cwd !== scope.cwd || generations.get(scope.sessionId) !== generation) return;
        const json = JSON.stringify(payload);
        if (latestJson.get(scope.sessionId) === json) return;
        latestJson.set(scope.sessionId, json);
        latestPayload.set(scope.sessionId, payload);
        if (payload.warning !== undefined) {
          host.onNotice(`subagent catalog for ${scope.cwd} is unavailable (${payload.warning})`);
        }
        host.publish(scope.sessionId, payload);
      };

      const refresh = async (scope: HubSessionScope): Promise<void> => {
        const generation = (generations.get(scope.sessionId) ?? 0) + 1;
        generations.set(scope.sessionId, generation);
        try {
          const snapshot = await (read === undefined
            ? readSessionCatalog(host, scope, abort.signal, fallback)
            : read(scope.cwd));
          commit(scope, generation, {
            cwd: scope.cwd,
            agents: presentCatalog(snapshot.agents),
            models: catalogModels(snapshot.agents, snapshot.models),
          });
        } catch (error) {
          if (closed || abort.signal.aborted) return;
          const warning = error instanceof Error ? error.message : String(error);
          commit(scope, generation, { cwd: scope.cwd, agents: [], models: [], warning });
        }
      };

      const timer = setInterval(() => {
        for (const scope of scopes.values()) void refresh(scope);
      }, refreshMs);

      const source: HubChannelSource = {
        payloadFor(scope) {
          if (!scopes.has(scope.sessionId)) return undefined;
          void refresh(scope);
          return latestPayload.get(scope.sessionId);
        },
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          void refresh(scope);
        },
        sessionRemoved(sessionId) {
          scopes.delete(sessionId);
          latestJson.delete(sessionId);
          latestPayload.delete(sessionId);
          generations.delete(sessionId);
        },
        close() {
          closed = true;
          abort.abort();
          clearInterval(timer);
          scopes.clear();
          latestJson.clear();
          latestPayload.clear();
          generations.clear();
        },
      };
      return source;
    },
  };
}
