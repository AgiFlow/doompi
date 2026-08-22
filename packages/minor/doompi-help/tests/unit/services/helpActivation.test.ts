import type { DoomHelpContribution, DoomHelpSkill } from '@agimon-ai/doompi-extension-contracts/help';
import { describe, expect, it, vi } from 'vitest';
import { DefaultHelpActivationService, HelpActivationError } from '../../../src/services/helpActivation.ts';
import type { HelpActivationDependencies, ResolvedHelpIndex } from '../../../src/types/help.ts';

function contribution(source: string, name = `${source.split('/').at(-1)}-help`): DoomHelpContribution {
  return {
    source,
    moduleUrl: `file:///packages/${source.split('/').at(-1)}/extension.mjs`,
    skills: [{ name, description: `Help for ${source}.` }],
  };
}

function resolved(source: string, byteLength = 100): ResolvedHelpIndex {
  return {
    identity: {
      source,
      version: '1.0.0',
      packageRoot: `/packages/${source.split('/').at(-1)}`,
      modulePath: `/packages/${source.split('/').at(-1)}/extension.mjs`,
    },
    location: 'local',
    filePath: `/packages/${source.split('/').at(-1)}/llms.txt`,
    referenceBase: `/packages/${source.split('/').at(-1)}`,
    byteLength,
    digest: source,
  };
}

function skill(source: string, name: string): DoomHelpSkill {
  return {
    source,
    name,
    description: `Help for ${source}.`,
    filePath: `/cache/${source}/${name}/SKILL.md`,
    baseDir: `/cache/${source}/${name}`,
  };
}

function dependencies(overrides: Partial<HelpActivationDependencies> = {}) {
  const published: unknown[] = [];
  const defaults: HelpActivationDependencies = {
    resolver: { resolve: vi.fn(async (entry) => resolved(entry.source)) },
    materializer: {
      materialize: vi.fn(async (entry: DoomHelpContribution) =>
        entry.skills.map(({ name }) => skill(entry.source, name)),
      ),
    },
    publisher: { publish: vi.fn((snapshot) => published.push(snapshot)) },
    onBackgroundError: vi.fn(),
  };
  return { dependencies: { ...defaults, ...overrides }, published };
}

describe('Help activation service', () => {
  it('performs no loading while inactive and atomically publishes an active candidate', async () => {
    const fixture = dependencies();
    const service = new DefaultHelpActivationService(fixture.dependencies);
    service.replaceContributions([contribution('@agimon-ai/workflow')]);

    expect(fixture.dependencies.resolver.resolve).not.toHaveBeenCalled();
    const state = await service.activate();

    expect(state.activation).toBe('active');
    expect(state.skills.map(({ name }) => name)).toEqual(['workflow-help']);
    expect(fixture.published).toMatchObject([
      { activation: 'activating', skills: [] },
      { activation: 'active', skills: [{ name: 'workflow-help' }] },
    ]);
  });

  it('degrades on source failures and resolves Help collisions by sorted package source', async () => {
    const resolver = {
      resolve: vi.fn(async (entry: DoomHelpContribution) => {
        if (entry.source.endsWith('/broken')) throw new Error('offline');
        return resolved(entry.source);
      }),
    };
    const fixture = dependencies({ resolver });
    const service = new DefaultHelpActivationService(fixture.dependencies);
    service.replaceContributions([
      contribution('@agimon-ai/zeta', 'shared-help'),
      contribution('@agimon-ai/broken', 'broken-help'),
      contribution('@agimon-ai/alpha', 'shared-help'),
    ]);

    const state = await service.activate();

    expect(state.activation).toBe('degraded');
    expect(state.skills).toEqual([skill('@agimon-ai/alpha', 'shared-help')]);
    expect(state.diagnostics.map(({ code, source }) => [code, source])).toEqual([
      ['HELP_SOURCE_FAILED', '@agimon-ai/broken'],
      ['HELP_SKILL_COLLISION', '@agimon-ai/zeta'],
    ]);
  });

  it('discards a totally failed candidate and remains inactive', async () => {
    const fixture = dependencies({
      resolver: { resolve: vi.fn(async () => Promise.reject(new Error('unavailable'))) },
    });
    const service = new DefaultHelpActivationService(fixture.dependencies);
    service.replaceContributions([contribution('@agimon-ai/broken')]);

    await expect(service.activate()).rejects.toBeInstanceOf(HelpActivationError);

    expect(service.getState()).toMatchObject({ activation: 'inactive', skills: [] });
    expect(service.getState().diagnostics[0]).toMatchObject({ code: 'HELP_SOURCE_FAILED' });
  });

  it('deactivation immediately removes skills and aborts in-flight work', async () => {
    const resolver = {
      resolve: vi.fn(
        (_entry: DoomHelpContribution, signal: AbortSignal) =>
          new Promise<ResolvedHelpIndex>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      ),
    };
    const fixture = dependencies({ resolver });
    const service = new DefaultHelpActivationService(fixture.dependencies);
    service.replaceContributions([contribution('@agimon-ai/slow')]);
    const activation = service.activate();
    expect(service.getState().activation).toBe('activating');

    const inactive = service.deactivate();

    expect(inactive).toEqual({ activation: 'inactive', skills: [], diagnostics: [] });
    await expect(activation).rejects.toThrowError('cancelled');
    expect(service.getState().activation).toBe('inactive');
  });

  it('restores the last settled snapshot when an action signal cancels activation', async () => {
    let slow = false;
    const resolver = {
      resolve: vi.fn((entry: DoomHelpContribution, signal: AbortSignal) => {
        if (!slow) return Promise.resolve(resolved(entry.source));
        return new Promise<ResolvedHelpIndex>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }),
    };
    const fixture = dependencies({ resolver });
    const service = new DefaultHelpActivationService(fixture.dependencies);
    service.replaceContributions([contribution('@agimon-ai/alpha')]);
    await service.activate();

    slow = true;
    const controller = new AbortController();
    const activation = service.activate(controller.signal);
    controller.abort();

    await expect(activation).rejects.toThrowError('cancelled');
    expect(service.getState()).toMatchObject({
      activation: 'active',
      skills: [{ source: '@agimon-ai/alpha' }],
    });
  });

  it('does not report expected cancellation when deactivation stops reconciliation', async () => {
    let slow = false;
    const aborted = vi.fn();
    const resolver = {
      resolve: vi.fn((entry: DoomHelpContribution, signal: AbortSignal) => {
        if (!slow) return Promise.resolve(resolved(entry.source));
        return new Promise<ResolvedHelpIndex>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted();
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      }),
    };
    const backgroundError = vi.fn();
    const fixture = dependencies({ resolver, onBackgroundError: backgroundError });
    const service = new DefaultHelpActivationService(fixture.dependencies);
    service.replaceContributions([contribution('@agimon-ai/alpha')]);
    await service.activate();

    slow = true;
    service.replaceContributions([contribution('@agimon-ai/beta')]);
    service.deactivate();

    await vi.waitFor(() => expect(aborted).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(service.getState().activation).toBe('inactive');
    expect(backgroundError).not.toHaveBeenCalled();
  });

  it('keeps expected reconciliation failures in the published state', async () => {
    let unavailable = false;
    const resolver = {
      resolve: vi.fn(async (entry: DoomHelpContribution) => {
        if (unavailable) throw new Error('offline');
        return resolved(entry.source);
      }),
    };
    const backgroundError = vi.fn();
    const fixture = dependencies({ resolver, onBackgroundError: backgroundError });
    const service = new DefaultHelpActivationService(fixture.dependencies);
    service.replaceContributions([contribution('@agimon-ai/alpha')]);
    await service.activate();

    unavailable = true;
    service.replaceContributions([contribution('@agimon-ai/beta')]);

    await vi.waitFor(() => expect(service.getState().activation).toBe('inactive'));
    expect(service.getState().diagnostics).toMatchObject([{ code: 'HELP_SOURCE_FAILED' }]);
    expect(backgroundError).not.toHaveBeenCalled();
  });

  it('reconciles registration changes only while active', async () => {
    const backgroundError = vi.fn();
    const fixture = dependencies({ onBackgroundError: backgroundError });
    const service = new DefaultHelpActivationService(fixture.dependencies);
    service.replaceContributions([contribution('@agimon-ai/alpha')]);
    await service.activate();

    service.replaceContributions([contribution('@agimon-ai/beta')]);
    await vi.waitFor(() => expect(service.getState().skills.map(({ source }) => source)).toEqual(['@agimon-ai/beta']));
    service.replaceContributions([contribution('@agimon-ai/beta')]);

    expect(backgroundError).not.toHaveBeenCalled();
    expect(fixture.dependencies.resolver.resolve).toHaveBeenCalledTimes(2);
  });

  it('bounds aggregate loaded bytes and publishes state subscriptions', async () => {
    const fixture = dependencies({
      resolver: { resolve: vi.fn(async (entry) => resolved(entry.source, 1024 * 1024)) },
    });
    const service = new DefaultHelpActivationService(fixture.dependencies);
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    service.replaceContributions(Array.from({ length: 5 }, (_, index) => contribution(`@agimon-ai/source-${index}`)));

    const state = await service.activate();

    expect(state.activation).toBe('degraded');
    expect(state.skills).toHaveLength(4);
    expect(state.diagnostics[0]).toMatchObject({ code: 'HELP_AGGREGATE_LIMIT' });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    service.dispose();
    service.dispose();
    expect(service.getState().activation).toBe('inactive');
    await expect(service.activate()).rejects.toThrowError('disposed');
  });
});
