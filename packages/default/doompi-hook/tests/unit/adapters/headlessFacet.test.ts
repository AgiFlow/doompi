import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessHook,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_HEADLESS_HOST_SERVICE } from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { hookServerFacet } from '../../../src/extensions/server';

describe('hook headless facet', () => {
  it('records lifecycle hooks, clears shutdown status, and exposes authoring guidance', async () => {
    let resource: DoomHeadlessResource | undefined;
    const hooks: DoomHeadlessHook[] = [];
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
      registerHook: (hook: DoomHeadlessHook) => {
        hooks.push(hook);
        return registration();
      },
    } as unknown as DoomHeadlessHostService;
    const context = new Context();
    context.provide(DOOM_SERVER_HOST_SERVICE, { scope: 'session' });
    context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
    const close = await hookServerFacet.apply(context);
    if (!resource) throw new Error('Hook authoring resource was not registered');

    const appendCustomEntry = vi.fn();
    const setStatus = vi.fn();
    const execution = {
      session: { appendCustomEntry },
      client: { setStatus },
    } as unknown as DoomHeadlessExecutionContext;
    const beforeStart = hooks.find(({ event }) => event === 'before_agent_start');
    const shutdown = hooks.find(({ event }) => event === 'session_shutdown');
    if (!beforeStart || !shutdown) throw new Error('Hook lifecycle handlers were not registered');

    await beforeStart.handle({ type: 'before_agent_start', prompt: 'continue' } as never, execution);
    expect(appendCustomEntry).toHaveBeenCalledWith('doom-hook', {
      version: 1,
      event: 'before_agent_start',
      data: { type: 'before_agent_start', prompt: 'continue' },
    });
    await shutdown.handle({ type: 'session_shutdown' } as never, execution);
    expect(setStatus).toHaveBeenCalledWith('doom-hook', undefined);
    expect(await resource.read(execution)).toContain('hook');

    await close?.();
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
