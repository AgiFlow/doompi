import type { Context } from '@deepseek-ai/cordis';
import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
} from '@agimon-ai/doompi-core/headless';
import { describe, expect, it, vi } from 'vitest';
import { notificationServerFacet as notificationHeadlessFacet } from '../../src/extensions/server';

describe('notification headless command', () => {
  it('trims and forwards a non-empty notification body', async () => {
    let command: DoomHeadlessCommand | undefined;
    const dispose = vi.fn();
    const host = {
      registerCommand: (registered: DoomHeadlessCommand) => {
        command = registered;
        return { dispose };
      },
    } as unknown as DoomHeadlessHostService;
    const close = await notificationHeadlessFacet.apply({
      effect() {},
      get: (name: string) => (name === 'doom/server-host' ? { scope: 'session', context: {} } : host),
    } as unknown as Context);
    if (!command) throw new Error('Notification command was not registered');
    const notify = vi.fn();
    const execution = { client: { notify } } as unknown as DoomHeadlessExecutionContext;

    await command.execute('  Build complete  ', execution);
    expect(notify).toHaveBeenCalledWith({ body: 'Build complete', level: 'info' });

    notify.mockClear();
    await command.execute('   ', execution);
    expect(notify).not.toHaveBeenCalled();
    await close?.();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
