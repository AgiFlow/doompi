import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
} from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeActionRequest,
  type MinorModeCatalogService,
  type MinorModeRecord,
} from '@agimon-ai/doompi-extension-contracts/mode';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../../src/adapters/contextApi.ts';
import { doompiServerFacet } from '../../../src/adapters/server/facet.ts';
type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
    registerApi(candidate) {
      registered.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    mounted: () => registered.map((candidate) => candidate.basePath),
  };
  const context = {
    get: (name: string) => (name === DOOM_SERVER_HOST_SERVICE ? host : undefined),
  } as unknown as Context;
  return { context, registered, state };
}

describe('doompiServerFacet', () => {
  it('declares its host dependency', () => {
    expect(doompiServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact context API in session scope', () => {
    const harness = hostContext('session');
    expect(typeof doompiServerFacet.apply(harness.context)).toBe('function');
    expect(harness.registered).toEqual([api]);
  });

  it('unregisters the API on disposal', () => {
    const harness = hostContext('session');
    doompiServerFacet.apply(harness.context)?.();
    expect(harness.state.disposed).toBe(1);
  });

  it('does nothing in hub scope', () => {
    const harness = hostContext('hub');
    expect(doompiServerFacet.apply(harness.context)).toBeUndefined();
    expect(harness.registered).toEqual([]);
  });
});

function minorModeRecord(): MinorModeRecord {
  return {
    descriptor: {
      source: '@agimon-ai/test',
      id: 'plan',
      label: 'Plan',
      description: 'Planning mode.',
      order: 1,
      actions: [
        {
          id: 'start',
          label: 'Start',
          description: 'Start planning.',
          contexts: ['headless'],
          parameters: [{ name: 'note', label: 'Note', kind: 'string', required: true }],
        },
      ],
    },
    state: { activation: 'inactive', condition: 'ready', actions: [] },
    ownerGeneration: 'generation-1',
    registrationId: 'registration-1',
    stateRevision: 1,
  };
}

describe('doompiServerFacet headless minor command', () => {
  it('registers a typed headless adapter and invokes shared catalog behavior', async () => {
    const registered: Array<Parameters<DoomServerHostService['registerApi']>[0]> = [];
    const apiDispose = vi.fn();
    const commandDispose = vi.fn();
    const record = minorModeRecord();
    const invoke = vi.fn(async (request: MinorModeActionRequest) => ({
      operationId: request.operationId,
      catalogRevision: 1,
      mode: record,
    }));
    const catalog = {
      list: () => [record],
      invoke,
    } as unknown as MinorModeCatalogService;
    const request = vi.fn(async () => 'typed');
    const notify = vi.fn(async () => undefined);
    let command: DoomHeadlessCommand | undefined;
    const headless: DoomHeadlessHostService = {
      context: {} as DoomHeadlessHostService['context'],
      select: vi.fn(async () => undefined),
      registerMinorMode: vi.fn(),
      registerToolRestriction: vi.fn(),
      registerTool: vi.fn(),
      registerResource: vi.fn(),
      registerCommand: vi.fn((candidate) => {
        command = candidate;
        return { dispose: commandDispose };
      }),
      registerHook: vi.fn(),
      registerActivity: vi.fn(),
    };
    const server: DoomServerHostService = {
      scope: 'session',
      context: { locality: 'local' } as unknown as DoomServerHostService['context'],
      registerApi(candidate) {
        registered.push(candidate);
        return { dispose: apiDispose };
      },
      mounted: () => registered.map((candidate) => candidate.basePath),
    };
    const context = {
      get(name: string) {
        if (name === DOOM_SERVER_HOST_SERVICE) return server;
        if (name === DOOM_HEADLESS_HOST_SERVICE) return headless;
        if (name === DOOM_MINOR_MODE_CATALOG_SERVICE) return catalog;
        return undefined;
      },
    } as unknown as Context;

    const dispose = doompiServerFacet.apply(context);
    expect(command?.name).toBe('minor');
    expect(registered).toEqual([api]);

    const execution = {
      client: { request, notify, setStatus: vi.fn() },
    } as unknown as DoomHeadlessExecutionContext;
    await command!.execute('plan start', execution);

    expect(request).toHaveBeenCalledWith({ kind: 'input', title: 'Start: Note', message: '' });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      actionId: 'start',
      mode: { id: 'plan', ownerGeneration: 'generation-1', registrationId: 'registration-1' },
      arguments: { note: 'typed' },
    });
    expect(notify).toHaveBeenCalledWith({ body: 'Plan is inactive.', level: 'info' });

    dispose?.();
    expect(commandDispose).toHaveBeenCalledOnce();
    expect(apiDispose).toHaveBeenCalledOnce();
  });
});
