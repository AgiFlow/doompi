import { describe, expect, it } from 'vitest';
import type { SubagentCatalogAgent } from '../../src/types/webSubagents.ts';
import { agentMeta, filterCatalog, groupCatalog, launchCommand, modelChoices } from '../../web/launchCommand.ts';

const row = (name: string, source: SubagentCatalogAgent['source'], extra: Partial<SubagentCatalogAgent> = {}) =>
  ({
    name,
    source,
    description: `${name} does things`,
    fallbackModels: [],
    tools: [],
    skills: [],
    extensions: [],
    defaultContext: 'fresh',
    filePath: `/x/${name}.md`,
    ...extra,
  }) satisfies SubagentCatalogAgent;

describe('the launch command', () => {
  it('writes the /run line the session parses: agent[model], the task as the rest, --fork last', () => {
    expect(launchCommand({ agent: 'reviewer', task: '', fork: false })).toBe('/run reviewer');
    expect(launchCommand({ agent: 'reviewer', task: '  Review the diff.  ', model: 'x/y', fork: true })).toBe(
      '/run reviewer[model=x/y] Review the diff. --fork',
    );
    expect(launchCommand({ agent: 'r', task: 'line one\nline two', fork: false })).toBe('/run r line one\nline two');
    expect(launchCommand({ agent: 'r', task: '', fork: true })).toBe('/run r --fork');
  });
});

describe('the catalog view helpers', () => {
  const agents = [
    row('reviewer', 'project', { tools: ['read', 'grep'] }),
    row('doc-writer', 'user', { packageName: undefined }),
    row('scout', 'plugin', { packageName: '@agimon-ai/doompi-team', tools: ['bash'] }),
  ];

  it('filters on name, source, package, description and tools, case-insensitively', () => {
    expect(filterCatalog(agents, '')).toEqual(agents);
    expect(filterCatalog(agents, '')).not.toBe(agents);
    expect(filterCatalog(agents, 'GREP').map((agent) => agent.name)).toEqual(['reviewer']);
    expect(filterCatalog(agents, 'doompi-team').map((agent) => agent.name)).toEqual(['scout']);
    expect(filterCatalog(agents, 'user').map((agent) => agent.name)).toEqual(['doc-writer']);
    expect(filterCatalog(agents, 'nothing')).toEqual([]);
  });

  it('groups by source in shadowing order and leaves empty sections out', () => {
    expect(groupCatalog(agents).map((section) => [section.label, section.agents.map((agent) => agent.name)])).toEqual([
      ['PROJECT', ['reviewer']],
      ['USER', ['doc-writer']],
      ['PACKAGES', ['scout']],
    ]);
    expect(groupCatalog([agents[2]!]).map((section) => section.source)).toEqual(['plugin']);
  });

  it('offers the agent own models before the team ones, once each', () => {
    const agent = row('a', 'user', { model: 'm1', fallbackModels: ['m2', 't1'] });
    expect(modelChoices(agent, ['t1', 't2'])).toEqual(['m1', 'm2', 't1', 't2']);
    expect(modelChoices(row('b', 'user'), [])).toEqual([]);
  });

  it('summarises tools, skills and context in one line', () => {
    expect(agentMeta(row('a', 'user'))).toBe('all tools · fresh context');
    expect(
      agentMeta(row('b', 'user', { tools: ['a', 'b', 'c', 'd'], skills: ['s', 't'], defaultContext: 'fork' })),
    ).toBe('tools a, b, c +1 · 2 skills · forks the session');
    expect(agentMeta(row('c', 'user', { tools: ['a'], skills: ['s'] }))).toBe('tools a · 1 skill · fresh context');
  });
});
