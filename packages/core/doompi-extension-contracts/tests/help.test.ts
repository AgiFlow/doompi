import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  createDoomHelpService,
  DOOM_HELP_ERROR_CODE,
  DOOM_HELP_MAX_CONTRIBUTORS,
  DOOM_HELP_SERVICE,
  type DoomHelpContribution,
  readDoomHelpService,
  requireDoomHelpService,
} from '../src/schemas/help.ts';

function contribution(source = '@agimon-ai/example-help', moduleUrl = 'file:///packages/example/dist/extension.mjs') {
  return {
    source,
    moduleUrl,
    skills: [{ name: 'example-help', description: 'Explain the example package.' }],
  } satisfies DoomHelpContribution;
}

describe('Doom Help Cordis service', () => {
  it('replaces one source atomically and fences stale disposal', () => {
    const service = createDoomHelpService('help-generation');
    const changed = vi.fn();
    service.subscribeContributions(changed);
    const original = service.register(contribution('@agimon-ai/reload-help', 'file:///old.mjs'));
    const replacement = service.register(contribution('@agimon-ai/reload-help', 'file:///new.mjs'));

    original.dispose();
    expect(service.listContributions()).toEqual([contribution('@agimon-ai/reload-help', 'file:///new.mjs')]);
    replacement.dispose();
    expect(service.listContributions()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('validates duplicate descriptors and inactive snapshots', () => {
    const service = createDoomHelpService('help-generation');
    const duplicate = contribution();
    duplicate.skills.push({ ...duplicate.skills[0]! });

    expect(() => service.register(duplicate)).toThrowError(
      expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.duplicateSkill }),
    );
    expect(() =>
      service.publish({
        activation: 'inactive',
        skills: [
          {
            source: '@agimon-ai/example-help',
            name: 'example-help',
            description: 'Explain the example package.',
            filePath: '/cache/example-help/SKILL.md',
            baseDir: '/cache/example-help',
          },
        ],
        diagnostics: [],
      }),
    ).toThrowError(expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.inactiveSnapshot }));
  });

  it('publishes cloned snapshots to live subscribers', () => {
    const service = createDoomHelpService('help-generation');
    const changed = vi.fn();
    service.subscribeSnapshot(changed);
    const published = service.publish({
      activation: 'active',
      skills: [
        {
          source: '@agimon-ai/example-help',
          name: 'example-help',
          description: 'Explain the example package.',
          filePath: '/cache/example-help/SKILL.md',
          baseDir: '/cache/example-help',
        },
      ],
      diagnostics: [],
    });

    expect(published).toMatchObject({ hostGeneration: 'help-generation', revision: 1, activation: 'active' });
    expect(changed).toHaveBeenCalledWith(published);
    expect(service.getSnapshot()).not.toBe(published);
  });

  it('is discoverable only while the provider fiber is live', async () => {
    const root = new Context();
    const service = createDoomHelpService('help-generation');
    const fiber = root.plugin((context) => context.provide(DOOM_HELP_SERVICE, service));
    await fiber.await();

    expect(readDoomHelpService(root)).toBe(service);
    expect(requireDoomHelpService(root)).toBe(service);
    await fiber.dispose();
    expect(readDoomHelpService(root)).toBeUndefined();
    expect(() => requireDoomHelpService(root)).toThrow('Doom Help is unavailable.');
    await root.fiber.dispose();
  });

  it('rejects invalid generations and malformed contributions with typed errors', () => {
    expect(() => createDoomHelpService('')).toThrowError(
      expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.invalidGeneration }),
    );

    const service = createDoomHelpService('help-generation');
    expect(() => service.register({ ...contribution(), source: '' })).toThrowError(
      expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.invalidContribution }),
    );
    expect(() => service.register(undefined as unknown as DoomHelpContribution)).toThrowError(
      expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.invalidContribution }),
    );
  });

  it('bounds contributors without blocking a same-source reload', () => {
    const service = createDoomHelpService('bounded-help');
    for (let index = 0; index < DOOM_HELP_MAX_CONTRIBUTORS; index += 1) {
      service.register(contribution(`@test/help-${String(index).padStart(2, '0')}`));
    }

    expect(service.listContributions()).toHaveLength(DOOM_HELP_MAX_CONTRIBUTORS);
    expect(() => service.register(contribution('@test/help-overflow'))).toThrowError(
      expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.contributorLimit }),
    );
    expect(() => service.register(contribution('@test/help-00', 'file:///replacement.mjs'))).not.toThrow();
  });

  it('isolates published state and rejects malformed snapshots', () => {
    const service = createDoomHelpService('snapshot-help');
    const changed = vi.fn();
    const unsubscribe = service.subscribeSnapshot(changed);
    const skill = {
      source: '@test/help',
      name: 'example-help',
      description: 'Explain the example package.',
      filePath: '/cache/example-help/SKILL.md',
      baseDir: '/cache/example-help',
    };
    const published = service.publish({
      activation: 'degraded',
      skills: [skill],
      diagnostics: [{ source: '@test/help', code: 'READ_FAILED', message: 'Could not read the skill.' }],
    });

    published.skills[0]!.description = 'consumer mutation';
    published.diagnostics[0]!.message = 'consumer mutation';
    expect(service.getSnapshot()).toMatchObject({
      activation: 'degraded',
      skills: [{ description: 'Explain the example package.' }],
      diagnostics: [{ message: 'Could not read the skill.' }],
    });
    unsubscribe();
    service.publish({ activation: 'active', skills: [], diagnostics: [] });
    expect(changed).toHaveBeenCalledTimes(1);

    expect(() =>
      service.publish({ activation: 'active', skills: [{ ...skill, name: 'INVALID NAME' }], diagnostics: [] }),
    ).toThrowError(expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.invalidSnapshot }));
  });

  it('makes subscriptions, handles, and disposal safely idempotent', () => {
    const service = createDoomHelpService('disposed-help');
    const changed = vi.fn();
    const unsubscribe = service.subscribeContributions(changed);
    const handle = service.register(contribution());

    unsubscribe();
    unsubscribe();
    handle.dispose();
    handle.dispose();
    expect(changed).toHaveBeenCalledTimes(1);

    service.dispose();
    service.dispose();
    expect(() => service.register(contribution())).toThrowError(
      expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.disposed }),
    );
    expect(() => service.subscribeContributions(vi.fn())).toThrowError(
      expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.disposed }),
    );
    expect(() => service.subscribeSnapshot(vi.fn())).toThrowError(
      expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.disposed }),
    );
    expect(() => service.publish({ activation: 'inactive', skills: [], diagnostics: [] })).toThrowError(
      expect.objectContaining({ code: DOOM_HELP_ERROR_CODE.disposed }),
    );
  });
});
