import { describe, expect, it } from 'vitest';
import {
  type CatalogAgentInput,
  catalogAgentOf,
  catalogModels,
  presentCatalog,
} from '../../src/services/webSubagentCatalog.ts';

const agent = (
  name: string,
  source: CatalogAgentInput['source'],
  extra: Partial<CatalogAgentInput> = {},
): CatalogAgentInput => ({ name, source, description: `${name} does things`, filePath: `/x/${name}.md`, ...extra });

describe('the subagent catalog projection', () => {
  it('turns definitions into rows, nearest source first and then by name', () => {
    const rows = presentCatalog([
      agent('zeta', 'plugin', {
        packageName: '@agimon-ai/doompi-team',
        model: 'm1',
        fallbackModels: ['m2'],
        tools: ['read'],
        defaultContext: 'fork',
      }),
      agent('beta', 'project'),
      agent('alpha', 'user', { skills: ['s'] }),
      agent('alpha-2', 'project'),
    ]);
    expect(rows.map((row) => `${row.source}:${row.name}`)).toEqual([
      'project:alpha-2',
      'project:beta',
      'user:alpha',
      'plugin:zeta',
    ]);
    expect(rows[3]).toEqual({
      name: 'zeta',
      source: 'plugin',
      packageName: '@agimon-ai/doompi-team',
      description: 'zeta does things',
      model: 'm1',
      fallbackModels: ['m2'],
      tools: ['read'],
      skills: [],
      extensions: [],
      defaultContext: 'fork',
      filePath: '/x/zeta.md',
    });
    const plain = catalogAgentOf(agent('beta', 'project'));
    expect(plain).not.toHaveProperty('model');
    expect(plain).not.toHaveProperty('packageName');
    expect(plain.defaultContext).toBe('fresh');
  });

  it('offers every model once, the team offer first', () => {
    const agents = [
      agent('a', 'user', { model: 'm1', fallbackModels: ['m2', 't1'] }),
      agent('b', 'user', { model: 'm1' }),
    ];
    expect(catalogModels(agents, ['t1', 't2'])).toEqual(['t1', 't2', 'm1', 'm2']);
    expect(catalogModels([], [])).toEqual([]);
  });
});
