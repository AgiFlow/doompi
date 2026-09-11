import path from 'node:path';
import { AGENT_CATALOG_VERSION, type AgentCatalog } from '../types/agentCatalog.ts';
import type { SessionRecord } from '../types/registry.ts';

/** Deliberate allowlist: never spread a registry record into a remotely visible projection. */
export function projectAgentCatalog(
  hubId: string,
  records: readonly SessionRecord[],
  grants?: readonly string[],
): AgentCatalog {
  const allowed = grants === undefined ? undefined : new Set(grants);
  return {
    version: AGENT_CATALOG_VERSION,
    hubId,
    agents: records
      .filter((record) => allowed === undefined || allowed.has(record.id))
      .map((record) => ({
        version: AGENT_CATALOG_VERSION,
        hubId,
        agentId: record.id,
        name: record.name,
        project: path.basename(record.cwd),
        createdAt: record.createdAt,
        status: 'live',
      })),
  };
}

/** Treat peer discovery as untrusted data, never as a source of further peers or local paths. */
export function parsePeerAgentCatalog(value: unknown, hubId: string): AgentCatalog {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid peer catalog.');
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== AGENT_CATALOG_VERSION ||
    raw.hubId !== hubId ||
    !Array.isArray(raw.agents) ||
    raw.agents.length > 1024
  )
    throw new Error('Invalid peer catalog identity or size.');
  const ids = new Set<string>();
  const agents = raw.agents.map((value: unknown): AgentCatalog['agents'][number] => {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid peer agent.');
    const entry = value as Record<string, unknown>;
    if (
      entry.version !== AGENT_CATALOG_VERSION ||
      entry.hubId !== hubId ||
      entry.status !== 'live' ||
      typeof entry.agentId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(entry.agentId) ||
      ids.has(entry.agentId) ||
      typeof entry.name !== 'string' ||
      entry.name.length > 256 ||
      typeof entry.project !== 'string' ||
      entry.project.length > 256 ||
      /[/\\\\]/.test(entry.project) ||
      typeof entry.createdAt !== 'string' ||
      entry.createdAt.length > 64 ||
      !Number.isFinite(Date.parse(entry.createdAt))
    )
      throw new Error('Invalid, duplicate, or transitive peer agent.');
    ids.add(entry.agentId);
    return {
      version: AGENT_CATALOG_VERSION,
      hubId,
      agentId: entry.agentId,
      name: entry.name,
      project: entry.project,
      createdAt: entry.createdAt,
      status: 'live' as const,
    };
  });
  return { version: AGENT_CATALOG_VERSION, hubId, agents };
}
