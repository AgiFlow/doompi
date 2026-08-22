import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import {
  DOOM_TOOL_OVERRIDES_SERVICE,
  createDoomToolOverridesService,
  readDoomToolOverrides,
  requireDoomToolOverrides,
} from '../src/exports/toolOverrides.ts';

describe('Doom tool override contract', () => {
  it('grants and releases one atomic first-owner claim', () => {
    const service = createDoomToolOverridesService('runtime-1');
    const edit = service.claim({ source: '@example/edit', tools: ['read', 'grep', 'edit', 'read'] });

    expect(edit).toMatchObject({ granted: true, tools: ['read', 'grep', 'edit'] });
    expect(service.owner('read')).toBe('@example/edit');
    expect(service.owner('write')).toBeUndefined();

    const conflict = service.claim({ source: '@example/other', tools: ['write', 'read'] });
    expect(conflict.granted).toBe(false);
    expect(service.owner('write')).toBeUndefined();

    edit.dispose();
    edit.dispose();
    expect(service.owner('read')).toBeUndefined();
    expect(service.claim({ source: '@example/other', tools: ['write', 'read'] }).granted).toBe(true);
  });

  it('publishes through Cordis and rejects invalid claims', async () => {
    const root = new Context();
    const service = createDoomToolOverridesService('runtime-1');
    const fiber = root.plugin((context) => context.provide(DOOM_TOOL_OVERRIDES_SERVICE, service));
    await fiber.await();

    expect(readDoomToolOverrides(root)).toBe(service);
    expect(requireDoomToolOverrides(root)).toBe(service);
    expect(() => service.claim({ source: '', tools: ['read'] })).toThrow('source must not be empty');
    expect(() => service.claim({ source: '@example/edit', tools: [] })).toThrow('tools must not be empty');
    expect(() => service.claim({ source: '@example/edit', tools: [''] })).toThrow('tool must not be empty');

    await fiber.dispose();
    expect(readDoomToolOverrides(root)).toBeUndefined();
    expect(() => requireDoomToolOverrides(root)).toThrow('Doom tool overrides are unavailable');
    await root.fiber.dispose();
  });
});
