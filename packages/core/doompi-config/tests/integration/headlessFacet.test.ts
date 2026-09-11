import type { Context } from '@deepseek-ai/cordis';
import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { describe, expect, it, vi } from 'vitest';
import { configHeadlessFacet } from '../../src/adapters/headless/facet.ts';

describe('config headless resources', () => {
  it('projects the active selection and loads the authoring skill', async () => {
    const resources: DoomHeadlessResource[] = [];
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const host = {
      registerResource: (resource: DoomHeadlessResource) => {
        resources.push(resource);
        const dispose = vi.fn();
        disposers.push(dispose);
        return { dispose };
      },
    } as unknown as DoomHeadlessHostService;
    const close = configHeadlessFacet.apply({ get: () => host } as unknown as Context);
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
    close();
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
