import { describe, expect, it } from 'vitest';
import {
  type ContextItem,
  contextGroups,
  ownerLabel,
  ownersOf,
  totalTokens,
} from '../../src/web/lib/contextComposition.ts';

// The same live capture the status-line parser is tested against, so the
// grouping is driven by what DoomPi really publishes rather than a guess.
const LIVE_STATUS =
  '\u001B[38;2;81;175;239m[copilot]\u001B[39m\u001B[38;2;91;98;104m:\u001B[39m\u001B[38;2;156;160;164mdevelopment,testing\u001B[39m';

const statuses = (raw: string): Record<string, string> => ({ 'doom-major-mode': raw });

function item(name: string, source: ContextItem['source'], tokens: number | null): ContextItem {
  return { name, itemKind: 'tool', source, owner: 'pkg', tokens, active: true };
}

describe('contextGroups', () => {
  it('reads the major mode and its domains from the footer status line', () => {
    const groups = contextGroups(statuses(LIVE_STATUS), []);
    expect(groups.map((group) => [group.kind, group.label])).toEqual([
      ['major', 'copilot'],
      ['domain', 'development'],
      ['domain', 'testing'],
    ]);
  });

  it('marks a pending major-mode switch without inventing a second group', () => {
    const pending = '\u001B[38;2;236;190;123m[minimal]\u001B[39m\u001B[38;2;156;160;164mdevelopment\u001B[39m';
    const groups = contextGroups(statuses(pending), []);
    expect(groups[0]).toMatchObject({ kind: 'major', label: 'minimal', detail: 'switching' });
  });

  it('reports no groups when the session has published nothing', () => {
    expect(contextGroups({}, [])).toEqual([]);
  });

  it('orders rows inside a group by source kind, then by name', () => {
    const items = [
      item('zeta_mcp', 'mcp', 10),
      item('alpha_plugin', 'plugin', 10),
      item('beta_ext', 'extension', 10),
      item('alpha_ext', 'extension', 10),
    ];
    const attribution = Object.fromEntries(items.map((entry) => [entry.name, 'copilot']));
    const groups = contextGroups(statuses(LIVE_STATUS), [], null, items, attribution);
    expect(groups[0]?.items.map((entry) => entry.name)).toEqual(['alpha_ext', 'beta_ext', 'zeta_mcp', 'alpha_plugin']);
  });

  it('subtotals a group and totals the composition', () => {
    const items = [item('read', 'extension', 180), item('bash', 'extension', 240), item('scaffold', 'mcp', 910)];
    const groups = contextGroups(statuses(LIVE_STATUS), [], null, items, {
      read: 'copilot',
      bash: 'copilot',
      scaffold: 'development',
    });
    expect(groups.find((group) => group.id === 'copilot')?.tokens).toBe(420);
    expect(groups.find((group) => group.id === 'development')?.tokens).toBe(910);
    expect(totalTokens(groups)).toBe(1330);
  });

  it('lists an unattributed tool under core rather than dropping it', () => {
    const groups = contextGroups(statuses(LIVE_STATUS), [], null, [item('mystery', 'core', 55)], {});
    const core = groups.at(-1);
    expect(core).toMatchObject({ kind: 'core', id: 'core' });
    expect(core?.items.map((entry) => entry.name)).toEqual(['mystery']);
  });

  it('reports null rather than a confident zero when nothing is priced', () => {
    const groups = contextGroups(statuses(LIVE_STATUS), [], null, [item('read', 'extension', null)], {
      read: 'copilot',
    });
    expect(groups[0]?.tokens).toBeNull();
    expect(totalTokens(groups)).toBeNull();
  });
});

function owned(name: string, owner: string, source: ContextItem['source'], tokens: number, active = true): ContextItem {
  return { name, itemKind: 'tool', source, owner, tokens, active };
}

describe('ownersOf', () => {
  it("gathers a mode's rows under the package that registered them", () => {
    const items = [
      owned('task', '@agimon-ai/doompi-task', 'extension', 2482),
      owned('subagent', '@agimon-ai/doompi-team', 'extension', 758),
      owned('intercom', '@agimon-ai/doompi-team', 'extension', 257),
    ];
    const attribution = Object.fromEntries(items.map((entry) => [entry.name, 'copilot']));
    const [group] = contextGroups(statuses(LIVE_STATUS), [], null, items, attribution);
    const owners = ownersOf(group!);

    expect(owners.map((entry) => entry.owner)).toEqual(['@agimon-ai/doompi-task', '@agimon-ai/doompi-team']);
    expect(owners[1]?.items.map((entry) => entry.name)).toEqual(['intercom', 'subagent']);
    expect(owners[1]?.tokens).toBe(1015);
  });

  it('orders packages by source kind before name', () => {
    const items = [
      owned('scaffold', 'scaffold-mcp', 'mcp', 10),
      owned('review', 'testing', 'plugin', 10),
      owned('bash', '@agimon-ai/doompi-runner', 'extension', 10),
    ];
    const attribution = Object.fromEntries(items.map((entry) => [entry.name, 'copilot']));
    const [group] = contextGroups(statuses(LIVE_STATUS), [], null, items, attribution);

    expect(ownersOf(group!).map((entry) => entry.source)).toEqual(['extension', 'mcp', 'plugin']);
  });

  // A gated tool belongs to its package but is not being paid for, so the
  // package subtotal has to keep the two apart exactly as the group total does.
  it('splits a package subtotal into paid and gated', () => {
    const items = [
      owned('narrate', '@agimon-ai/doompi-voice', 'extension', 336, false),
      owned('use_voice_tools', '@agimon-ai/doompi-voice', 'extension', 391, false),
    ];
    const attribution = Object.fromEntries(items.map((entry) => [entry.name, 'copilot']));
    const [group] = contextGroups(statuses(LIVE_STATUS), [], null, items, attribution);
    const [voice] = ownersOf(group!);

    expect(voice?.tokens).toBe(0);
    expect(voice?.inactiveTokens).toBe(727);
  });
});

describe('ownerLabel', () => {
  it('drops the scope, which the rows beneath already imply', () => {
    expect(ownerLabel('@agimon-ai/doompi-team')).toBe('doompi-team');
  });

  it('leaves an unscoped server or plugin name alone', () => {
    expect(ownerLabel('scaffold-mcp')).toBe('scaffold-mcp');
  });
});
