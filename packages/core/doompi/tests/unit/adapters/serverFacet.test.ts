import { headlessMinorModeCommand } from '@agimon-ai/doompi-minor-mode';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
} from '@agimon-ai/doompi-core/headless';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeActionRequest,
  type MinorModeCatalogService,
  type MinorModeRecord,
} from '@agimon-ai/doompi-minor-mode';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@agimon-ai/doompi-core/runtime-context-api';
import { machineApi } from '@agimon-ai/doompi-core/machine-api';
import { remoteApi } from '@agimon-ai/doompi-core/remote-api';
import { sessionFilesApi } from '@agimon-ai/doompi-core/session-files-api';
import { doompiServerFacet } from '../../../src/extensions/server';
type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

function hostContext(scope: DoomServerHostService['scope'], remoteControl = false) {
  const registered: MountedApi[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local', remoteControl } as unknown as DoomServerHostService['context'],
    registerApi(candidate) {
      registered.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    registerChannel: () => ({ dispose: () => undefined }),
    registerMethod: () => ({ dispose: () => undefined }),
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => [],
  };
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, host);
  return { context, registered, state };
}

describe('doompiServerFacet', () => {
  it('declares its host dependency', () => {
    expect(doompiServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact context API in session scope', async () => {
    const harness = hostContext('session');
    const dispose = await doompiServerFacet.apply(harness.context);
    expect(typeof dispose).toBe('function');
    expect(harness.registered).toEqual([api, sessionFilesApi]);
    await dispose?.();
  });

  it('unregisters the API on disposal', async () => {
    const harness = hostContext('session');
    await (
      await doompiServerFacet.apply(harness.context)
    )?.();
    expect(harness.state.disposed).toBe(2);
  });

  it.each([false, true])('preserves remote API selection in global scope (%s)', async (remoteControl) => {
    const harness = hostContext('global', remoteControl);
    const dispose = await doompiServerFacet.apply(harness.context);
    expect(harness.registered).toEqual(remoteControl ? [machineApi, remoteApi] : [machineApi]);
    await dispose?.();
    expect(harness.state.disposed).toBe(remoteControl ? 2 : 1);
  });

  it('does nothing in workspace scope', async () => {
    const harness = hostContext('workspace');
    expect(await doompiServerFacet.apply(harness.context)).toBeUndefined();
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
      changeSelection: vi.fn(async () => undefined),
      assertActive: vi.fn(),
      subscribeSelection: vi.fn(() => vi.fn()),
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
      registerChannel: () => ({ dispose: () => undefined }),
      registerMethod: () => ({ dispose: () => undefined }),
      mounted: () => registered.map((candidate) => candidate.basePath),
      mountedChannels: () => [],
    };
    const context = new Context();
    context.provide(DOOM_SERVER_HOST_SERVICE, server);
    context.provide(DOOM_HEADLESS_HOST_SERVICE, headless);
    context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, catalog);

    const dispose = await doompiServerFacet.apply(context);
    const commandHandle = headless.registerCommand(headlessMinorModeCommand(catalog));
    expect(command?.name).toBe('minor');
    expect(registered).toEqual([api, sessionFilesApi]);

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

    await dispose?.();
    commandHandle.dispose();
    expect(commandDispose).toHaveBeenCalledOnce();
    expect(apiDispose).toHaveBeenCalledTimes(2);
  });
});
