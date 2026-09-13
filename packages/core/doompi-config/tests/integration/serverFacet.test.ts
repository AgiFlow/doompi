import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_HEADLESS_HOST_SERVICE } from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { configServerFacet } from '../../src/extensions/server';

describe('config server resources', () => {
  it('declares the server host and publishes selection and authoring resources', async () => {
    const resources: DoomHeadlessResource[] = [];
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const headlessHost = {
      registerResource: (resource: DoomHeadlessResource) => {
        resources.push(resource);
        const dispose = vi.fn();
        disposers.push(dispose);
        return { dispose };
      },
    } as unknown as DoomHeadlessHostService;
    const serverHost = {
      scope: 'session',
      context: {},
      registerApi: () => ({ dispose: vi.fn() }),
      registerChannel: () => ({ dispose: vi.fn() }),
      mounted: () => [],
      mountedChannels: () => [],
    } as unknown as DoomServerHostService;
    const context = new Context();
    context.provide(DOOM_SERVER_HOST_SERVICE, serverHost);
    context.provide(DOOM_HEADLESS_HOST_SERVICE, headlessHost);

    expect(configServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
    const close = await configServerFacet.apply(context);
    const execution = {
      selection: {
        majorMode: 'development',
        activeLayers: ['tools'],
        domains: ['typescript'],
        profile: 'focused',
        minorModes: [],
      },
    } as unknown as DoomHeadlessExecutionContext;

    const projected = resources.find(({ name }) => name === 'doompi/config');
    const authoring = resources.find(({ name }) => name === 'doompi-author-config');
    if (!projected || !authoring) throw new Error('Config resources were not registered');
    expect(await projected.read(execution)).toBe(
      JSON.stringify({
        profile: 'focused',
        domains: ['typescript'],
        majorMode: 'development',
        activeLayers: ['tools'],
      }),
    );
    expect(await authoring.read(execution)).toContain('doompi');
    await close?.();
    await context.fiber.dispose();
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
