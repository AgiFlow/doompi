import type { LeaderBindingContribution } from '@agimon-ai/doompi-web-contracts';
import { describe, expect, it } from 'vitest';
import { leaderConflicts, leaderGroup } from '../../src/web/lib/leaderTree.ts';

const WORKFLOWS = { key: 'w', label: 'workflows', detail: 'multi-step agent runs' };
const noop = (): void => undefined;

const BINDINGS: LeaderBindingContribution[] = [
  { id: 'w.runs', path: [WORKFLOWS, { key: 'r', label: 'runs', detail: 'runs in this session' }], run: noop },
  { id: 'w.toggle', path: [WORKFLOWS, { key: 'e', label: 'toggle' }], command: 'minor workflow' },
  {
    id: 'g.toggle',
    path: [
      { key: 'g', label: 'goal' },
      { key: 'e', label: 'toggle' },
    ],
    command: 'minor goal',
  },
];

describe('leaderGroup', () => {
  it('lists the root groups sorted by key with their children previewed', () => {
    const root = leaderGroup(BINDINGS, []);
    expect(root?.label).toBe('leader');
    expect(
      root?.options.map((option) => [option.key, option.label, option.children.map((child) => child.key)]),
    ).toEqual([
      ['g', 'goal', ['e']],
      ['w', 'workflows', ['e', 'r']],
    ]);
    expect(root?.options[1]?.detail).toBe('multi-step agent runs');
    expect(root?.options[1]?.binding).toBeUndefined();
  });

  it('walks a path to the leaves that fire', () => {
    const group = leaderGroup(BINDINGS, ['w']);
    expect(group?.label).toBe('workflows');
    expect(group?.options.map((option) => [option.key, option.binding?.id])).toEqual([
      ['e', 'w.toggle'],
      ['r', 'w.runs'],
    ]);
    expect(group?.options[1]?.detail).toBe('runs in this session');
  });

  it('is undefined past a leaf or off the tree', () => {
    expect(leaderGroup(BINDINGS, ['w', 'r'])).toBeUndefined();
    expect(leaderGroup(BINDINGS, ['z'])).toBeUndefined();
    expect(leaderGroup([], [])?.options).toEqual([]);
  });

  it('keeps the first label for a shared group and adopts a detail it lacked', () => {
    const group = leaderGroup(
      [
        {
          id: 'a',
          path: [
            { key: 'w', label: 'workflows' },
            { key: 'r', label: 'runs' },
          ],
          run: noop,
        },
        {
          id: 'b',
          path: [
            { key: 'w', label: 'flows', detail: 'later detail' },
            { key: 'l', label: 'list' },
          ],
          run: noop,
        },
      ],
      [],
    );
    expect(group?.options[0]).toMatchObject({ key: 'w', label: 'workflows', detail: 'later detail' });
  });

  it('lets a later binding take a leaf over, and a group over a leaf', () => {
    const takeover = leaderGroup(
      [
        {
          id: 'first',
          path: [
            { key: 'g', label: 'goal' },
            { key: 'e', label: 'enter' },
          ],
          command: 'one',
        },
        {
          id: 'second',
          path: [
            { key: 'g', label: 'goal' },
            { key: 'e', label: 'toggle' },
          ],
          command: 'two',
        },
      ],
      ['g'],
    );
    expect(takeover?.options[0]).toMatchObject({ key: 'e', label: 'toggle', binding: { id: 'second' } });

    const regrouped = leaderGroup(
      [
        { id: 'leaf', path: [{ key: 'g', label: 'goal' }], command: 'goal' },
        {
          id: 'child',
          path: [
            { key: 'g', label: 'goal' },
            { key: 'e', label: 'toggle' },
          ],
          command: 'minor goal',
        },
      ],
      [],
    );
    expect(regrouped?.options[0]?.binding).toBeUndefined();
    expect(
      leaderGroup(
        [
          {
            id: 'child',
            path: [
              { key: 'g', label: 'goal' },
              { key: 'e', label: 'toggle' },
            ],
            command: 'minor goal',
          },
          { id: 'leaf', path: [{ key: 'g', label: 'goal' }], command: 'goal' },
        ],
        [],
      )?.options[0],
    ).toMatchObject({ binding: { id: 'leaf' }, children: [] });
  });
});

describe('leaderConflicts', () => {
  const enter: LeaderBindingContribution = {
    id: 'first',
    path: [
      { key: 'g', label: 'goal' },
      { key: 'e', label: 'enter' },
    ],
    command: 'one',
  };
  const toggle: LeaderBindingContribution = {
    id: 'second',
    path: [
      { key: 'g', label: 'goals' },
      { key: 'e', label: 'toggle' },
    ],
    command: 'two',
  };
  const leaf: LeaderBindingContribution = { id: 'leaf', path: [{ key: 'g', label: 'goal' }], command: 'goal' };

  it('is empty for bindings that only share a group worded the same way', () => {
    expect(leaderConflicts(BINDINGS)).toEqual([]);
  });

  it('names the winner and loser of a leaf takeover and of a reworded group', () => {
    expect(leaderConflicts([enter, toggle])).toEqual([
      { kind: 'group-label', path: 'g', winner: enter, loser: toggle },
      { kind: 'leaf-override', path: 'g e', winner: toggle, loser: enter },
    ]);
  });

  it('reports a group crossing a leaf and a leaf covering a group as takeovers', () => {
    expect(leaderConflicts([leaf, enter])).toEqual([{ kind: 'leaf-override', path: 'g', winner: enter, loser: leaf }]);
    expect(leaderConflicts([enter, leaf])).toEqual([{ kind: 'leaf-override', path: 'g', winner: leaf, loser: enter }]);
  });
});
