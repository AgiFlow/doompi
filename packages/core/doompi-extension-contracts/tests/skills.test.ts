import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  createDoomSkillSourcesService,
  DOOM_SKILL_SOURCES_SERVICE,
  readDoomSkillSourcesService,
  requireDoomSkillSourcesService,
} from '../src/schemas/skills.ts';

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

  it('rejects malformed contributions and use after disposal', () => {
    const service = createDoomSkillSourcesService('skills-generation');
    expect(() => service.register({ source: '', directories: ['/skills'] })).toThrow(TypeError);
    service.dispose();
    expect(() => service.register({ source: '@agimon-ai/workflow', directories: ['/skills'] })).toThrow(/disposed/u);
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
    await root.fiber.dispose();
  });
});
