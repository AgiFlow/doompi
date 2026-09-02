import type { PackageAttribution } from '@agimon-ai/doompi-config/types';
import type { SkillEntry } from '@agimon-ai/doompi-skill/catalog';
import type { ToolSource } from '@agimon-ai/doompi-ui/toolInventory';
import { describe, expect, it } from 'vitest';
import { projectContext } from '../../src/services/contextProjection.ts';

// One token per character, so every figure below is checkable by hand.
const countTokens = (text: string): number => text.length;

const TEAM: PackageAttribution = { kind: 'major', mode: 'copilot', layer: 'team' };
const DEV: PackageAttribution = { kind: 'domain', mode: 'development' };

function source(overrides: Partial<ToolSource> & Pick<ToolSource, 'key' | 'kind'>): ToolSource {
  return { label: overrides.key, tools: [], ...overrides };
}

function tool(name: string, active = true) {
  return { name, description: 'd', active };
}

function skill(overrides: Partial<SkillEntry> & Pick<SkillEntry, 'name' | 'owner' | 'group'>): SkillEntry {
  return {
    description: 'd',
    filePath: '/x/SKILL.md',
    baseDir: '/x',
    modelInvocable: true,
    ...overrides,
  };
}

function project(input: Partial<Parameters<typeof projectContext>[0]> = {}) {
  return projectContext({
    revision: 1,
    majorMode: 'copilot',
    minorModes: [],
    domains: [],
    sources: [],
    skills: [],
    attribution: {},
    countTokens,
    ...input,
  });
}

describe('projectContext', () => {
  it('files a layer package under the major mode that admitted it', () => {
    const result = project({
      sources: [
        source({
          key: '/x/pi.mjs',
          kind: 'extension',
          packageName: '@agimon-ai/doompi-team',
          tools: [tool('subagent')],
        }),
      ],
      attribution: { '@agimon-ai/doompi-team': TEAM },
    });

    expect(result.groups.map((group) => [group.kind, group.id])).toEqual([['major', 'copilot']]);
    expect(result.groups[0]?.items.map((item) => item.name)).toEqual(['subagent']);
  });

  it('files a domain plugin skill under its domain', () => {
    const result = project({
      skills: [skill({ name: 'doompi-review', owner: 'testing', group: 'plugins', promptTokens: 40 })],
      attribution: { testing: { kind: 'domain', mode: 'testing' } },
    });
    const domain = result.groups.find((group) => group.kind === 'domain');

    expect(domain?.id).toBe('testing');
    expect(domain?.items[0]).toMatchObject({ name: 'doompi-review', itemKind: 'skill', source: 'plugin', tokens: 40 });
  });

  // The failure this guards is silent: an unattributed tool that vanished would
  // still be costing context while the total claimed otherwise.
  it('keeps an unattributed tool visible under core', () => {
    const result = project({
      sources: [
        source({ key: '/y/pi.mjs', kind: 'extension', packageName: '@scope/unknown', tools: [tool('mystery')] }),
      ],
    });
    const core = result.groups.find((group) => group.kind === 'core');

    expect(core?.items.map((item) => item.name)).toEqual(['mystery']);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it('puts Pi builtins under core without needing attribution', () => {
    const result = project({ sources: [source({ key: 'core', kind: 'core', tools: [tool('read')] })] });

    expect(result.groups.find((group) => group.kind === 'core')?.items[0]).toMatchObject({
      name: 'read',
      source: 'core',
    });
  });

  it('orders rows extension, then mcp, then plugin', () => {
    const result = project({
      sources: [
        source({ key: 'mcp:scaffold', kind: 'mcp', label: 'scaffold', tools: [tool('scaffold_list')] }),
        source({
          key: '/x/pi.mjs',
          kind: 'extension',
          packageName: '@agimon-ai/doompi-team',
          tools: [tool('subagent')],
        }),
      ],
      skills: [skill({ name: 'writing', owner: 'blog', group: 'plugins' })],
      attribution: {
        '@agimon-ai/doompi-team': { kind: 'domain', mode: 'development' },
        scaffold: { kind: 'domain', mode: 'development' },
        blog: { kind: 'domain', mode: 'development' },
      },
    });

    expect(result.groups.find((group) => group.id === 'development')?.items.map((item) => item.source)).toEqual([
      'extension',
      'mcp',
      'plugin',
    ]);
  });

  it('subtotals each group and totals the composition', () => {
    const result = project({
      sources: [
        source({
          key: '/x/pi.mjs',
          kind: 'extension',
          packageName: '@agimon-ai/doompi-team',
          tools: [tool('subagent')],
        }),
      ],
      skills: [skill({ name: 'review', owner: 'testing', group: 'plugins', promptTokens: 40 })],
      attribution: { '@agimon-ai/doompi-team': TEAM, testing: { kind: 'domain', mode: 'testing' } },
    });
    const major = result.groups.find((group) => group.id === 'copilot');

    expect(major?.tokens).toBe(major?.items.reduce((sum, item) => sum + item.tokens, 0));
    expect(result.totalTokens).toBe(result.groups.reduce((sum, group) => sum + group.tokens, 0));
  });

  // An active mode that costs nothing is a useful fact; a missing row reads as
  // a bug in the surface rather than as an answer.
  it('shows an active mode that brought nothing', () => {
    const result = project({ minorModes: [{ id: 'plan', label: 'plan' }] });

    expect(result.groups.map((group) => group.id)).toEqual(['copilot', 'plan']);
    expect(result.groups.every((group) => group.items.length === 0)).toBe(true);
    expect(result.totalTokens).toBe(0);
  });

  it('orders groups major, minor, domain, then core', () => {
    const result = project({
      minorModes: [{ id: 'plan', label: 'plan' }],
      sources: [
        source({ key: 'core', kind: 'core', tools: [tool('read')] }),
        source({ key: '/d/pi.mjs', kind: 'extension', packageName: '@scope/dev', tools: [tool('scaffold')] }),
      ],
      attribution: { '@scope/dev': DEV },
    });

    expect(result.groups.map((group) => group.kind)).toEqual(['major', 'minor', 'domain', 'core']);
  });

  // Pi builds the prompt from its active tools, so a gated one is not sent and
  // costs nothing yet. Counting it would overstate the bill; hiding it would
  // lose the answer to "what would turning this on cost me".
  it('keeps a gated tool out of the total but still prices it', () => {
    const result = project({
      sources: [source({ key: 'core', kind: 'core', tools: [tool('write', false)] })],
    });
    const core = result.groups.find((group) => group.kind === 'core');

    expect(core?.items[0]).toMatchObject({ name: 'write', active: false });
    expect(core?.items[0]?.tokens).toBeGreaterThan(0);
    expect(core?.tokens).toBe(0);
    expect(core?.inactiveTokens).toBe(core?.items[0]?.tokens);
    expect(result.totalTokens).toBe(0);
    expect(result.inactiveTokens).toBeGreaterThan(0);
  });

  it('separates what is being paid for from what is merely loaded', () => {
    const result = project({
      sources: [source({ key: 'core', kind: 'core', tools: [tool('read'), tool('narrate', false)] })],
    });
    const core = result.groups.find((group) => group.kind === 'core');
    const read = core?.items.find((item) => item.name === 'read');

    expect(core?.tokens).toBe(read?.tokens);
    expect(result.totalTokens).toBe(read?.tokens);
    expect(result.inactiveTokens).toBe(core?.items.find((item) => item.name === 'narrate')?.tokens);
  });

  it('stamps the version, revision, and estimator it was built with', () => {
    expect(project({ revision: 7 })).toMatchObject({ version: 1, revision: 7, estimator: 'gpt-tokenizer' });
  });
});

describe('MCP attribution', () => {
  // `label` is display text like `scaffold · mcp`. Joining or grouping on it
  // would invent an owner that matches nothing and reads as a stray suffix.
  it('owns an MCP tool by its server name, not its display label', () => {
    const result = project({
      sources: [source({ key: 'mcp:scaffold', kind: 'mcp', label: 'scaffold · mcp', tools: [tool('scaffold_list')] })],
      attribution: { scaffold: { kind: 'domain', mode: 'development' } },
    });
    const domain = result.groups.find((group) => group.id === 'development');

    expect(domain?.items[0]).toMatchObject({ name: 'scaffold_list', source: 'mcp', owner: 'scaffold' });
  });

  it('keeps an unattributed MCP server out of the extension buckets', () => {
    const result = project({
      sources: [source({ key: 'mcp:lonely', kind: 'mcp', label: 'lonely · mcp', tools: [tool('lonely_call')] })],
    });
    const core = result.groups.find((group) => group.kind === 'core');

    expect(core?.items[0]).toMatchObject({ source: 'mcp', owner: 'lonely' });
  });

  it('names Pi itself as the owner of its builtins', () => {
    const result = project({
      sources: [source({ key: 'core', kind: 'core', label: 'pi · core', tools: [tool('read')] })],
    });

    expect(result.groups.find((group) => group.kind === 'core')?.items[0]).toMatchObject({ owner: 'pi' });
  });
});
