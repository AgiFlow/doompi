import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  createDoomSkillSourcesService,
  DOOM_SKILL_SOURCES_SERVICE,
  readDoomSkillSourcesService,
  requireDoomSkillSourcesService,
} from '../src/schemas/skills';

describe('Doom skill-sources Cordis service', () => {
  it('replaces a source and makes stale disposal harmless', () => {
    const service = createDoomSkillSourcesService('skills-generation');
    const changed = vi.fn();
    service.subscribe(changed);
    const original = service.register({ source: '@agimon-ai/workflow', directories: ['/old'] });
    const replacement = service.register({ source: '@agimon-ai/workflow', directories: ['/new'] });

    original.dispose();
    expect(service.list()).toEqual([{ source: '@agimon-ai/workflow', directories: ['/new'] }]);
    replacement.dispose();
    expect(service.list()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed generations and contributions and use after disposal', () => {
    expect(() => createDoomSkillSourcesService('')).toThrow(/valid generation/u);
    expect(() => createDoomSkillSourcesService('x'.repeat(257))).toThrow(/valid generation/u);

    const service = createDoomSkillSourcesService('skills-generation');
    expect(() => service.register({ source: '', directories: ['/skills'] })).toThrow(TypeError);
    expect(() => service.register({ source: '@agimon-ai/workflow', directories: [''] })).toThrow(TypeError);
    service.dispose();
    service.dispose();
    expect(() => service.register({ source: '@agimon-ai/workflow', directories: ['/skills'] })).toThrow(/disposed/u);
  });

  it('sorts isolated snapshots and stops notifying unsubscribed listeners', () => {
    const service = createDoomSkillSourcesService('skills-generation');
    const changed = vi.fn();
    const unsubscribe = service.subscribe(changed);
    const second = service.register({ source: 'z-source', directories: ['/z'] });
    service.register({ source: 'a-source', directories: ['/a'] });

    const listed = service.list();
    expect(listed.map(({ source }) => source)).toEqual(['a-source', 'z-source']);
    expect(listed[0]).not.toBe(service.list()[0]);
    unsubscribe();
    expect(unsubscribe()).toBe(false);
    second.dispose();
    second.dispose();
    expect(changed).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('is discoverable only while the provider fiber is live', async () => {
    const root = new Context();
    const service = createDoomSkillSourcesService('skills-generation');
    const fiber = root.plugin((context) => context.provide(DOOM_SKILL_SOURCES_SERVICE, service));
    await fiber.await();

    expect(readDoomSkillSourcesService(root)).toBe(service);
    expect(requireDoomSkillSourcesService(root)).toBe(service);
    await fiber.dispose();
    expect(readDoomSkillSourcesService(root)).toBeUndefined();
    expect(() => requireDoomSkillSourcesService(root)).toThrow('Doom skill sources are unavailable');
    await root.fiber.dispose();
  });
});
