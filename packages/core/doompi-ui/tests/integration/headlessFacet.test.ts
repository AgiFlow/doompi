import type { Context } from '@deepseek-ai/cordis';
import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { describe, expect, it, vi } from 'vitest';
import { uiHeadlessFacet } from '../../src/adapters/headless/facet.ts';

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
    const close = uiHeadlessFacet.apply({ get: () => host } as unknown as Context);
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

    close();
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
