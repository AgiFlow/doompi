import { describe, expect, it } from 'vitest';
import { type ContextItem, contextGroups, totalTokens } from '../../src/web/lib/contextComposition.ts';

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
