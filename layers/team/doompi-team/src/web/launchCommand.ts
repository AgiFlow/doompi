import type { SubagentCatalogAgent, SubagentCatalogSource } from '../types/webSubagents.ts';

/** The session's own verb, whose parser takes agent[model=x], then the rest as the task, then a trailing --fork. */
const RUN_VERB = '/run';
const FORK_FLAG = '--fork';
const META_TOOL_LIMIT = 3;

export interface LaunchRequest {
  agent: string;
  task: string;
  /** A pinned model becomes the inline model=… config; absent keeps the agent's own. */
  model?: string;
  fork: boolean;
}

/** The slash line to send as a prompt; no quoting, since /run reads everything after the agent as the task. */
export function launchCommand({ agent, task, model, fork }: LaunchRequest): string {
  const target = model ? `${agent}[model=${model}]` : agent;
  const body = task.trim();
  return [RUN_VERB, target, ...(body ? [body] : []), ...(fork ? [FORK_FLAG] : [])].join(' ');
}

/** Rows whose name, source, package, description or a tool contains the filter, case-insensitively. */
export function filterCatalog(agents: readonly SubagentCatalogAgent[], filter: string): SubagentCatalogAgent[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return [...agents];
  return agents.filter((agent) =>
    [agent.name, agent.source, agent.packageName ?? '', agent.description, ...agent.tools].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

export interface CatalogSection {
  source: SubagentCatalogSource;
  label: string;
  agents: SubagentCatalogAgent[];
}

const SECTION_LABEL: Readonly<Record<SubagentCatalogSource, string>> = {
  project: 'PROJECT',
  user: 'USER',
  plugin: 'PACKAGES',
};

/** The catalog's sections, nearest source first, keeping the payload's order inside each; empty ones are left out. */
export function groupCatalog(agents: readonly SubagentCatalogAgent[]): CatalogSection[] {
  const sections: CatalogSection[] = [];
  for (const source of ['project', 'user', 'plugin'] as const) {
    const members = agents.filter((agent) => agent.source === source);
    if (members.length > 0) sections.push({ source, label: SECTION_LABEL[source], agents: members });
  }
  return sections;
}

/** What the picker offers: the agent's own model and fallbacks first, then the team's, without repeats. */
export function modelChoices(agent: SubagentCatalogAgent, models: readonly string[]): string[] {
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const model of [agent.model ?? '', ...agent.fallbackModels, ...models]) {
    if (model === '' || seen.has(model)) continue;
    seen.add(model);
    choices.push(model);
  }
  return choices;
}

/** The row's one-liner: what tools it may use, how many skills, and how it starts. */
export function agentMeta(agent: SubagentCatalogAgent): string {
  const tools =
    agent.tools.length === 0
      ? 'all tools'
      : `tools ${agent.tools.slice(0, META_TOOL_LIMIT).join(', ')}${
          agent.tools.length > META_TOOL_LIMIT ? ` +${agent.tools.length - META_TOOL_LIMIT}` : ''
        }`;
  const skills =
    agent.skills.length > 0 ? ` · ${agent.skills.length} skill${agent.skills.length === 1 ? '' : 's'}` : '';
  return `${tools}${skills} · ${agent.defaultContext === 'fork' ? 'forks the session' : 'fresh context'}`;
}
