import { Context } from '@deepseek-ai/cordis';
import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import { describe, expect, it, vi } from 'vitest';
import { uiServerFacet } from '../../src/extensions/server';

describe('UI headless inventory', () => {
  it('reports sorted unique tool names through the resource and command', async () => {
    let resource: DoomHeadlessResource | undefined;
    let command: DoomHeadlessCommand | undefined;
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const registration = () => {
      const dispose = vi.fn();
      disposers.push(dispose);
      return { dispose };
    };
    const host = {
      registerResource: (registered: DoomHeadlessResource) => {
        resource = registered;
        return registration();
      },
      registerCommand: (registered: DoomHeadlessCommand) => {
        command = registered;
        return registration();
      },
    } as unknown as DoomHeadlessHostService;
    const context = new Context();
    context.provide('doom/server-host', { scope: 'session' });
    context.provide('doom/headless-host', host);
    const close = await uiServerFacet.apply(context);
    if (!resource || !command) throw new Error('UI headless registrations were not created');
    const notify = vi.fn();
    const entries = vi.fn(() => [
      {
        message: {
          content: [
            { type: 'toolCall', name: 'write' },
            { type: 'toolCall', name: 'read' },
          ],
        },
      },
      { message: { content: [{ type: 'toolCall', name: 'write' }] } },
      { message: 'ignored' },
    ]);
    const execution = { client: { notify }, session: { entries } } as unknown as DoomHeadlessExecutionContext;

    expect(await resource.read(execution)).toBe('read\nwrite');
    await command.execute('', execution);
    expect(notify).toHaveBeenCalledWith({ title: 'DoomPi tools', body: 'read\nwrite', level: 'info' });

    await close?.();
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
