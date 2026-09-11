export const AGENT_CATALOG_VERSION = 1;
export const AGENT_CATALOG_ROUTE = '/api/agents';
export const FEDERATION_IDENTITY_ROUTE = '/api/federation/identity';
export const FEDERATION_PEERS_ROUTE = '/api/federation/peers';

export interface AgentCatalogEntry {
  version: typeof AGENT_CATALOG_VERSION;
  hubId: string;
  agentId: string;
  name: string;
  project: string;
  createdAt: string;
  status: 'live';
}

export interface AgentCatalog {
  version: typeof AGENT_CATALOG_VERSION;
  hubId: string;
  agents: AgentCatalogEntry[];
}

/** Public enrollment material, exchanged and confirmed by the two host operators. */
export interface FederationIdentity {
  hubId: string;
  publicKey: string;
  fingerprint: string;
}

export interface FederationPeer extends FederationIdentity {
  name: string;
  origin: string;
  /** Exact local agent IDs. Empty means no access; wildcard and transitive grants do not exist. */
  agentIds: string[];
}
