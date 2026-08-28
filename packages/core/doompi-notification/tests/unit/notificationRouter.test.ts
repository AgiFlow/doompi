import { DOOM_NOTIFICATION_ENTRY_TYPE } from '@agimon-ai/doompi-extension-contracts/notification';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { createDoomNotificationRouter } from '../../src/adapters/notificationRouter.ts';
import { execResult } from '../helpers/piHarness.ts';

function fixture(mode: ExtensionContext['mode'] = 'tui') {
  const appendEntry = vi.fn();
  const exec = vi.fn().mockResolvedValue(execResult());
  const getSessionName = vi.fn().mockReturnValue(undefined);
  const context = { cwd: '/repo/example', mode } as ExtensionContext;
  const pi = { appendEntry, exec, getSessionName } as unknown as ExtensionAPI;
  const router = createDoomNotificationRouter({ generation: 'notification-test', pi, context: () => context });
  return { appendEntry, context, exec, router };
}

describe('Doom notification router', () => {
  it('appends normalized RPC entries without invoking a host notifier', async () => {
    const { appendEntry, exec, router } = fixture('rpc');

    await router.request({ body: '  Saved\n successfully.  ', level: 'warning' });

    expect(appendEntry).toHaveBeenCalledWith(DOOM_NOTIFICATION_ENTRY_TYPE, {
      version: 1,
      title: 'Pi',
      subtitle: 'example',
      body: 'Saved successfully.',
      level: 'warning',
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['tui', 'json', 'print'] as const)('uses host delivery in %s mode', async (mode) => {
    const { appendEntry, exec, router } = fixture(mode);

    await router.request({ title: 'Build', subtitle: 'Workspace', body: 'Finished' });

    expect(exec).toHaveBeenCalledWith(
      'cmux',
      ['notify', '--title', 'Build', '--subtitle', 'Workspace', '--body', 'Finished'],
      { timeout: 3_000 },
    );
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it('keeps RPC append failures silent and never falls back to host delivery', async () => {
    const { appendEntry, exec, router } = fixture('rpc');
    appendEntry.mockImplementation(() => {
      throw new Error('append failed');
    });

    await expect(router.request({ body: 'Saved' })).resolves.toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { body: 42 }, { body: 'Saved', extra: true }, { body: 'Saved', level: 'success' }])(
    'silently rejects malformed runtime request %# without any delivery',
    async (request) => {
      for (const mode of ['rpc', 'tui'] as const) {
        const { appendEntry, exec, router } = fixture(mode);

        await (router.request as (value: unknown) => Promise<void>)(request);

        expect(appendEntry).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
      }
    },
  );

  it('stays silent without an active session context', async () => {
    const appendEntry = vi.fn();
    const exec = vi.fn();
    const pi = { appendEntry, exec, getSessionName: vi.fn() } as unknown as ExtensionAPI;
    const router = createDoomNotificationRouter({ generation: 'notification-test', pi, context: () => undefined });

    await router.request({ body: 'Saved' });

    expect(appendEntry).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
