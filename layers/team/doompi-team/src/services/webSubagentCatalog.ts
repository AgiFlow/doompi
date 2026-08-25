import type { SubagentCatalogAgent, SubagentCatalogSource } from '../types/webSubagents.ts';

/** The fields the catalog reads off an agent definition; an AgentConfig satisfies it. */
export interface CatalogAgentInput {
  name: string;
  packageName?: string;
  description: string;
  model?: string;
  fallbackModels?: string[];
  tools?: string[];
  skills?: string[];
  extensions?: string[];
  defaultContext?: 'fresh' | 'fork';
  source: SubagentCatalogSource;
  filePath: string;
}

/** Nearest definition first: the order shadowing resolves in. */
const SOURCE_ORDER: Readonly<Record<SubagentCatalogSource, number>> = { project: 0, user: 1, plugin: 2 };
const DEFAULT_CONTEXT = 'fresh';

export function catalogAgentOf(agent: CatalogAgentInput): SubagentCatalogAgent {
  return {
    name: agent.name,
    source: agent.source,
    ...(agent.packageName === undefined ? {} : { packageName: agent.packageName }),
    description: agent.description,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    fallbackModels: agent.fallbackModels ?? [],
    tools: agent.tools ?? [],
    skills: agent.skills ?? [],
    extensions: agent.extensions ?? [],
    defaultContext: agent.defaultContext ?? DEFAULT_CONTEXT,
    filePath: agent.filePath,
  };
}

/** The catalog's order: by source, nearest first, then by name. */
export function presentCatalog(agents: readonly CatalogAgentInput[]): SubagentCatalogAgent[] {
  return agents
    .map(catalogAgentOf)
    .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.name.localeCompare(b.name));
}

/** Every model spec a launch could name: the team's offer plus whatever the definitions pin, deduplicated in order. */
export function catalogModels(agents: readonly CatalogAgentInput[], teamModels: readonly string[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const model of [
    ...teamModels,
    ...agents.flatMap((agent) => [agent.model ?? '', ...(agent.fallbackModels ?? [])]),
  ]) {
    if (model === '' || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}
