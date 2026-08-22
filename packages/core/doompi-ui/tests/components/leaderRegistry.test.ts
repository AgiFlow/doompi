import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoomLeaderBinding } from '../../src/exports/leader.ts';
import { DoomLeaderRegistry } from '../../src/exports/leaderRegistry.ts';
import { TASK_LEADER_BINDING, TASK_LEADER_SOURCE } from '../helpers/leader.ts';

const PLAN_BINDING: DoomLeaderBinding = {
  id: 'plan.toggle',
  path: [
    { key: 'p', label: 'plan', order: 60 },
    { key: 'p', label: 'toggle', detail: 'read-only mode' },
  ],
  command: { name: 'plan' },
};

describe('DoomLeaderRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps optional plan bindings out of the core leader map', () => {
    const root = new DoomLeaderRegistry().getGroup([]);

    expect(root?.options.map((option) => option.key)).toEqual(['e', 'h', 'm', 'q', 's']);
  });

  it('exposes tasks on t once doom-task contributes', () => {
    const registry = new DoomLeaderRegistry();

    registry.register({ source: TASK_LEADER_SOURCE, bindings: [TASK_LEADER_BINDING] });

    const options = registry.getGroup([])?.options ?? [];
    expect(options).toContainEqual(expect.objectContaining({ key: 't', label: 'tasks' }));
    // A contributed group takes its alphabetical seat like any other, rather than
    // whatever position its `order` value used to buy it.
    const keys = options.map((option) => option.key);
    expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right)));
  });

  it('sorts a group by key even where the declared order disagrees', () => {
    const registry = new DoomLeaderRegistry();

    // Core sessions are declared new/resume/tree/fork at 10/20/30/40.
    expect(registry.getGroup(['s'])?.options.map((option) => option.key)).toEqual(['f', 'n', 'r', 't']);
  });

  it('exposes hotkeys at h/h so help extensions can use sibling keys', () => {
    const registry = new DoomLeaderRegistry();

    expect(registry.getGroup(['h'])?.options).toMatchObject([
      { key: 'h', label: 'hotkeys', action: { type: 'command', command: { name: 'hotkeys' } } },
    ]);
  });

  it('keeps the core extension and model actions reachable off t', () => {
    const registry = new DoomLeaderRegistry();
    registry.register({ source: TASK_LEADER_SOURCE, bindings: [TASK_LEADER_BINDING] });

    // Sorted by key, not by declared order, as the group-ordering test above asserts.
    expect(registry.getGroup(['e'])?.options).toMatchObject([
      { key: 'c', label: 'config', action: { type: 'command', command: { name: 'config' } } },
      { key: 't', label: 'tools', action: { type: 'command', command: { name: 'tools' } } },
    ]);
    // `SPC e e` opened an external editor, which said nothing about what it
    // would open or where; the key is free for a package that wants it.
    expect(registry.getGroup(['e'])?.options.some((option) => option.key === 'e')).toBe(false);
    expect(registry.getGroup(['m'])?.options).toContainEqual(
      expect.objectContaining({ key: 't', label: 'thinking', action: { type: 'app', action: 'app.thinking.cycle' } }),
    );
    // `t` is now a command leaf, so it has no group to descend into.
    expect(registry.getGroup(['t'])).toBeUndefined();
  });

  it('hands t to the source that claimed it last, keeping the first wording', () => {
    const registry = new DoomLeaderRegistry();
    registry.register({ source: TASK_LEADER_SOURCE, bindings: [TASK_LEADER_BINDING] });

    const result = registry.register({
      source: '@example/conflict',
      bindings: [
        {
          id: 'tickets.open',
          path: [{ key: 't', label: 'tickets', order: 65 }],
          command: { name: 'tickets' },
        },
      ],
    });

    expect(result.diagnostics.some((item) => item.message.includes(TASK_LEADER_SOURCE))).toBe(true);
    // The row keeps the first registrant's wording; the key runs the newcomer.
    expect(registry.getGroup([])?.options).toContainEqual(
      expect.objectContaining({ key: 't', label: 'tasks', action: { type: 'command', command: { name: 'tickets' } } }),
    );
  });

  it('merges extension commands into ordered groups', () => {
    const registry = new DoomLeaderRegistry();

    const result = registry.register({
      source: '@agimon-ai/doompi-plan',
      bindings: [
        PLAN_BINDING,
        {
          id: 'plan.status',
          path: [
            { key: 'p', label: 'plan', order: 60 },
            { key: 's', label: 'status' },
          ],
          command: { name: 'plan', args: 'status' },
        },
      ],
    });

    expect(result).toEqual({ accepted: true, diagnostics: [] });
    expect(registry.getGroup([])?.options.map((option) => option.key)).toEqual(['e', 'h', 'm', 'p', 'q', 's']);
    expect(registry.getGroup(['p'])?.options).toMatchObject([
      { key: 'p', label: 'toggle', action: { type: 'command', command: { name: 'plan' } } },
      { key: 's', label: 'status', action: { type: 'command', command: { name: 'plan', args: 'status' } } },
    ]);
  });

  it('resolves typed extension actions with their owning source', () => {
    const registry = new DoomLeaderRegistry();

    const result = registry.register({
      source: '@agimon-ai/doompi-plan',
      bindings: [
        {
          id: 'plan.normal',
          path: [
            { key: 'p', label: 'plan', order: 60 },
            { key: 'p', label: 'normal' },
          ],
          action: { name: 'plan.normal' },
        },
      ],
    });

    expect(result).toEqual({ accepted: true, diagnostics: [] });
    expect(registry.getGroup(['p'])?.options[0]?.action).toEqual({
      type: 'extension',
      source: '@agimon-ai/doompi-plan',
      action: { name: 'plan.normal' },
    });
  });

  it('rejects mixed, missing, and unsafe action targets', () => {
    const registry = new DoomLeaderRegistry();
    const path = [{ key: 'p', label: 'plan' }];

    expect(
      registry.register({
        source: '@agimon-ai/doompi-plan',
        bindings: [{ id: 'plan.mixed', path, command: { name: 'plan' }, action: { name: 'plan.normal' } }],
      }).diagnostics[0]?.message,
    ).toContain('exactly one');
    expect(
      registry.register({ source: '@agimon-ai/doompi-plan', bindings: [{ id: 'plan.missing', path }] }).diagnostics[0]
        ?.message,
    ).toContain('exactly one');
    expect(
      registry.register({
        source: '@agimon-ai/doompi-plan',
        bindings: [{ id: 'plan.unsafe', path, action: { name: 'Plan Normal' } }],
      }).accepted,
    ).toBe(false);
    expect(registry.register({ source: 'unsafe source', bindings: [] }).accepted).toBe(false);
  });

  it('replaces and removes one source without duplicating bindings', () => {
    const registry = new DoomLeaderRegistry();
    registry.register({ source: '@agimon-ai/doompi-plan', bindings: [PLAN_BINDING] });

    registry.register({
      source: '@agimon-ai/doompi-plan',
      bindings: [
        {
          id: 'workspace.open',
          path: [{ key: 'w', label: 'workspace' }],
          command: { name: 'workspace' },
        },
      ],
    });

    expect(registry.getGroup([])?.options.some((option) => option.key === 'p')).toBe(false);
    expect(registry.getGroup([])?.options.some((option) => option.key === 'w')).toBe(true);

    registry.register({ source: '@agimon-ai/doompi-plan', bindings: [] });
    expect(registry.getGroup([])?.options.some((option) => option.key === 'w')).toBe(false);
  });

  it('rejects malformed updates without removing the previous valid source', () => {
    const registry = new DoomLeaderRegistry();
    registry.register({ source: '@agimon-ai/doompi-plan', bindings: [PLAN_BINDING] });

    const result = registry.register({
      source: '@agimon-ai/doompi-plan',
      bindings: [
        {
          id: 'plan.invalid',
          path: [{ key: 'P', label: 'plan' }],
          command: { name: 'plan' },
        },
      ],
    });

    expect(result.accepted).toBe(false);
    expect(result.diagnostics[0]?.message).toContain('key must match');
    expect(registry.getGroup(['p'])?.options[0]?.label).toBe('toggle');
  });

  it('lets a later contribution take a chord from core, and says whose it was', () => {
    const registry = new DoomLeaderRegistry();

    const result = registry.register({
      source: '@example/conflict',
      bindings: [
        {
          id: 'model.replace',
          path: [
            { key: 'm', label: 'models', order: 10 },
            { key: 'm', label: 'select', detail: 'choose model', order: 10 },
          ],
          command: { name: 'replace-model' },
        },
      ],
    });

    expect(result.accepted).toBe(true);
    expect(result.diagnostics).toHaveLength(1);
    // The warning stays, but the key ends up bound rather than reported and lost.
    expect(result.diagnostics[0]?.message).toContain('taken over from @agimon-ai/doompi-ui');
    expect(registry.getGroup(['m'])?.options[0]?.action).toEqual({
      type: 'command',
      command: { name: 'replace-model' },
    });
  });

  it('gives a chord back to its previous owner when the taker unregisters', () => {
    const registry = new DoomLeaderRegistry();
    registry.register({ source: TASK_LEADER_SOURCE, bindings: [TASK_LEADER_BINDING] });
    registry.register({
      source: '@example/conflict',
      bindings: [{ id: 'tickets.open', path: [{ key: 't', label: 'tasks', order: 65 }], command: { name: 'tickets' } }],
    });

    expect(registry.getGroup([])?.options.find((option) => option.key === 't')?.action).toMatchObject({
      command: { name: 'tickets' },
    });

    // The tree is rebuilt from what is still registered, so nothing had to be
    // remembered for the displaced binding to come back.
    registry.register({ source: '@example/conflict', bindings: [] });

    expect(registry.getGroup([])?.options.find((option) => option.key === 't')?.action).toMatchObject({
      command: { name: 'tasks' },
    });
  });

  it('rejects invalid contributions and duplicate binding ids', () => {
    const registry = new DoomLeaderRegistry();

    expect(registry.register(null).accepted).toBe(false);
    expect(registry.register({}).diagnostics[0]?.message).toContain('source');
    expect(registry.register({ source: '@example/source', bindings: 'invalid' }).diagnostics[0]?.message).toContain(
      'array',
    );
    expect(
      registry
        .register({ source: '@example/source', bindings: [PLAN_BINDING, PLAN_BINDING] })
        .diagnostics.some((item) => item.message.includes('duplicated')),
    ).toBe(true);
    expect(
      registry.register({
        source: '@example/source',
        bindings: [
          {
            id: 'invalid.order',
            path: [{ key: 'w', label: 'workspace', order: 1001 }],
            command: { name: 'workspace' },
          },
        ],
      }).accepted,
    ).toBe(false);
  });

  it('notifies active subscribers when a source is replaced', () => {
    const registry = new DoomLeaderRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    registry.register({ source: '@agimon-ai/doompi-plan', bindings: [PLAN_BINDING] });
    unsubscribe();
    registry.register({ source: '@agimon-ai/doompi-plan', bindings: [] });

    expect(listener).toHaveBeenCalledOnce();
  });

  it('batches deferred contributions into one rebuild', () => {
    const registry = new DoomLeaderRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.registerDeferred({ source: '@agimon-ai/doompi-plan', bindings: [PLAN_BINDING] });
    registry.registerDeferred({ source: TASK_LEADER_SOURCE, bindings: [TASK_LEADER_BINDING] });
    expect(listener).not.toHaveBeenCalled();

    registry.flush();
    expect(listener).toHaveBeenCalledOnce();
    expect(registry.getGroup([])?.options.map((option) => option.key)).toEqual(['e', 'h', 'm', 'p', 'q', 's', 't']);
  });

  it('reports mismatched shared-group metadata and takeovers without dropping either binding', () => {
    const registry = new DoomLeaderRegistry();
    registry.register({ source: '@example/alpha', bindings: [PLAN_BINDING] });

    const metadataConflict = registry.register({
      source: '@example/beta',
      bindings: [
        {
          id: 'plan.status',
          path: [
            { key: 'p', label: 'planning', order: 60 },
            { key: 's', label: 'status' },
          ],
          command: { name: 'plan', args: 'status' },
        },
      ],
    });
    const leafConflict = registry.register({
      source: '@example/leaf',
      bindings: [
        {
          id: 'model.child',
          path: [
            { key: 'm', label: 'models', order: 10 },
            { key: 'm', label: 'select', detail: 'choose model', order: 10 },
            { key: 'x', label: 'invalid child' },
          ],
          command: { name: 'model-child' },
        },
      ],
    });

    // A group worded two ways keeps the first wording and still registers the
    // newcomer's child; losing `SPC p s` over a label would cost a usable key.
    expect(metadataConflict.diagnostics[0]?.message).toContain('keeps the label from @example/alpha');
    expect(registry.getGroup(['p'])?.options.map((option) => option.key)).toContain('s');
    expect(registry.getGroup(['p'])?.label).toBe('plan');

    // A leaf that another package wants as a group becomes one, and the
    // displaced action is named.
    expect(leafConflict.diagnostics.some((item) => item.message.includes('taken over from'))).toBe(true);
    expect(registry.getGroup(['m', 'm'])?.options.map((option) => option.key)).toEqual(['x']);
  });

  it('carries a leaf tone through to the resolved option', () => {
    const registry = new DoomLeaderRegistry();
    registry.register({
      source: '@example/mode',
      bindings: [
        {
          id: 'mode.exit',
          path: [
            { key: 'z', label: 'zone', order: 20 },
            { key: 'e', label: 'exit', detail: 'leave the mode', tone: 'exit' },
          ],
          command: { name: 'mode-exit' },
        },
        {
          id: 'mode.other',
          path: [
            { key: 'z', label: 'zone', order: 20 },
            { key: 'o', label: 'other', tone: 'default' },
          ],
          command: { name: 'mode-other' },
        },
      ],
    });

    const options = registry.getGroup(['z'])?.options ?? [];
    expect(options.find((option) => option.key === 'e')?.tone).toBe('exit');
    expect(options.find((option) => option.key === 'o')?.tone).toBe('default');
  });

  it('ignores an unknown tone without dropping the binding', () => {
    const registry = new DoomLeaderRegistry();
    const result = registry.register({
      source: '@example/mode',
      bindings: [
        {
          id: 'mode.open',
          path: [
            { key: 'z', label: 'zone', order: 20 },
            { key: 'o', label: 'open', tone: 'shouting' },
          ],
          command: { name: 'mode-open' },
        },
      ],
    } as never);

    // A badge colour is cosmetic, so a contributor built against a newer
    // contract keeps its key rather than losing the whole menu over it.
    expect(result.accepted).toBe(true);
    expect(result.diagnostics).toEqual([]);
    const option = registry.getGroup(['z'])?.options.find((item) => item.key === 'o');
    expect(option?.label).toBe('open');
    expect(option?.tone).toBeUndefined();
  });

  it('shares a group across contributors that disagree on its subtitle', () => {
    const registry = new DoomLeaderRegistry();
    // These packages ship on independent npm versions, so one of them carrying a
    // newer subtitle must not cost the other its bindings.
    const withDetail = registry.register({
      source: '@example/alpha',
      bindings: [
        {
          id: 'alpha.open',
          path: [
            { key: 'z', label: 'zone', detail: 'a subtitle', order: 20 },
            { key: 'a', label: 'alpha' },
          ],
          command: { name: 'alpha' },
        },
      ],
    });
    const withoutDetail = registry.register({
      source: '@example/beta',
      bindings: [
        {
          id: 'beta.open',
          path: [
            { key: 'z', label: 'zone', order: 20 },
            { key: 'b', label: 'beta' },
          ],
          command: { name: 'beta' },
        },
      ],
    });

    expect(withDetail.accepted).toBe(true);
    expect(withoutDetail.accepted).toBe(true);
    expect(withoutDetail.diagnostics).toEqual([]);
    expect(registry.getGroup(['z'])?.options.map((option) => option.key)).toEqual(['a', 'b']);
    // The subtitle survives whichever order the two happened to register in.
    expect(registry.getGroup([])?.options.find((option) => option.key === 'z')?.detail).toBe('a subtitle');
  });
});
