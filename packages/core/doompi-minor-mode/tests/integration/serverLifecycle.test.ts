import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessHostService,
  type DoomHeadlessSelection,
  type DoomHeadlessHook,
  type DoomHeadlessCommand,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import server from '../../src/extensions/server';
import { requireMinorModeCatalog } from '../../src/schemas/mode';
import { restoreMinorModeSelection } from '../../src/services/projection';

async function fixture(entries: unknown[] = []) {
  const context = new Context();
  let selection: DoomHeadlessSelection = { majorMode: 'test', activeLayers: [], domains: [], state: {} };
  const changes = new Set<() => void | Promise<void>>();
  const commands: DoomHeadlessCommand[] = [];
  const hooks: DoomHeadlessHook[] = [];
  const appended = vi.fn(async () => undefined);
  const host = {
    get context() {
      return {
        sessionId: 'session',
        selection,
        session: { entries: async () => entries, appendCustomEntry: appended },
        client: { notify: vi.fn() },
      };
    },
    assertActive: vi.fn(),
    subscribeSelection(listener: () => void | Promise<void>) {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    async changeSelection(change: { key: string; values: string[] }) {
      selection = { ...selection, state: { ...selection.state, [change.key]: change.values } };
      for (const listener of changes) await listener();
    },
    registerCommand(command: DoomHeadlessCommand) {
      commands.push(command);
      return {
        dispose() {
          commands.splice(commands.indexOf(command), 1);
        },
      };
    },
    registerHook(hook: DoomHeadlessHook) {
      hooks.push(hook);
      return {
        dispose() {
          hooks.splice(hooks.indexOf(hook), 1);
        },
      };
    },
  } as unknown as DoomHeadlessHostService;
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  context.provide(DOOM_SERVER_HOST_SERVICE, { scope: 'session' } as DoomServerHostService);
  const release = await server.apply(context);
  const catalog = requireMinorModeCatalog(context);
  const owner = catalog.registerOwner({
    descriptor: { source: 'test', id: 'trace', label: 'Trace', description: 'Trace mode', order: 1, actions: [] },
    initialState: { activation: 'inactive', condition: 'ready', actions: [] },
    handleAction() {},
  });
  return {
    context,
    host,
    owner,
    commands,
    hooks,
    appended,
    changes,
    async close() {
      await release?.();
      await context.fiber.dispose();
    },
  };
}

describe('server minor-mode lifecycle', () => {
  it('restores feature state, publishes changes, and owns registrations through shutdown', async () => {
    const test = await fixture([
      { customType: 'doom-minor-modes', data: { modes: [{ id: 'trace', activation: 'active' }] } },
    ]);
    try {
      expect(test.commands.map(({ name }) => name)).toEqual(['minor']);
      expect(test.appended).not.toHaveBeenCalled();
      const startup = test.hooks.find((hook) => hook.event === 'session_start');
      if (!startup || startup.event !== 'session_start') throw new Error('Missing startup hook');
      await startup.handle({}, test.host.context);
      expect(test.host.context.selection.state).toEqual({ 'minor-mode': ['trace'] });
      expect(test.commands.map(({ name }) => name)).toEqual(['minor']);
      expect(test.appended).toHaveBeenCalledOnce();
      test.owner.publish({ activation: 'active', condition: 'ready', actions: [] });
      await vi.waitFor(() => expect(test.appended).toHaveBeenCalledTimes(2));
      await test.host.changeSelection({ axis: 'state', key: 'minor-mode', values: [] });
      expect(test.appended).toHaveBeenCalledTimes(2);
      const shutdown = test.hooks.find((hook) => hook.event === 'session_shutdown');
      if (!shutdown || shutdown.event !== 'session_shutdown') throw new Error('Missing shutdown hook');
      await shutdown.handle({}, test.host.context);
      test.owner.publish({ activation: 'inactive', condition: 'ready', actions: [] });
      await test.host.changeSelection({ axis: 'state', key: 'minor-mode', values: [] });
      expect(test.appended).toHaveBeenCalledTimes(2);
    } finally {
      await test.close();
    }
    expect(test.commands).toEqual([]);
    expect(test.hooks).toEqual([]);
    expect(test.changes.size).toBe(0);
  });

  it('ignores malformed history and takes the latest valid activation projection', () => {
    expect(
      restoreMinorModeSelection([
        null,
        {},
        { customType: 'other', data: {} },
        { customType: 'doom-minor-modes', data: { modes: 'bad' } },
      ]),
    ).toBeUndefined();
    expect(
      restoreMinorModeSelection([
        { customType: 'doom-minor-modes', data: { modes: [{ id: 'old', activation: 'active' }] } },
        {
          customType: 'doom-minor-modes',
          data: {
            modes: [
              null,
              { id: 42, activation: 'active' },
              { id: 'off', activation: 'inactive' },
              { id: 'trace', activation: 'active' },
              { id: 'trace', activation: 'active' },
            ],
          },
        },
      ]),
    ).toEqual(['trace']);
    expect(restoreMinorModeSelection([{ customType: 'doom-minor-modes', data: { modes: [] } }])).toEqual([]);
  });
});
