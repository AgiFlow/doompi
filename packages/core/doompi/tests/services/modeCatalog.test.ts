import type { MinorModeDescriptor, MinorModeState } from '@agimon-ai/doompi-extension-contracts/mode';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { createMinorModeCatalogHost } from '../../src/services/modeCatalog';

const SOURCE = '@agimon-ai/test-mode';
const descriptor: MinorModeDescriptor = {
  source: SOURCE,
  id: 'test',
  label: 'Test',
  description: 'Test minor mode.',
  order: 10,
  actions: [
    {
      id: 'activate',
      label: 'Activate',
      description: 'Activate test mode.',
      contexts: ['tui', 'headless'],
      parameters: [],
    },
  ],
};
const state: MinorModeState = {
  activation: 'inactive',
  condition: 'ready',
  actions: [{ id: 'activate', enabled: true }],
};
const context = { sessionManager: { getSessionId: () => 'session-1' } } as ExtensionContext;

function setup(actionTimeoutMs = 100) {
  return createMinorModeCatalogHost({ sessionKind: 'headless', context, actionTimeoutMs });
}

function reference(host: ReturnType<typeof setup>) {
  const record = host.list()[0];
  if (!record) throw new Error('owner was not registered');
  return {
    source: record.descriptor.source,
    id: record.descriptor.id,
    ownerGeneration: record.ownerGeneration,
    registrationId: record.registrationId,
  };
}

describe('minor-mode catalog service', () => {
  it('registers, publishes, and removes owners directly', () => {
    const host = setup();
    const changed = vi.fn();
    host.subscribe(changed);
    const owner = host.registerOwner({ descriptor, initialState: state, handleAction: vi.fn() });
    expect(host.list()).toHaveLength(1);
    expect(changed).toHaveBeenCalledOnce();
    owner.publish({ ...state, activation: 'active' });
    expect(host.list()[0]?.state.activation).toBe('active');
    expect(host.getSnapshot().revision).toBe(2);
    owner.dispose();
    expect(host.list()).toEqual([]);
  });

  it('invokes the exact live owner and returns its current record', async () => {
    const host = setup();
    const action = vi.fn(async (_id, _arguments, execution) => {
      expect(execution.context).toBe(context);
      return { message: 'activated' };
    });
    host.registerOwner({ descriptor, initialState: state, handleAction: action });
    await expect(
      host.invoke(
        { operationId: 'operation-1', mode: reference(host), actionId: 'activate', arguments: {} },
        '@agimon-ai/test',
      ),
    ).resolves.toMatchObject({ operationId: 'operation-1', message: 'activated' });
    expect(action).toHaveBeenCalledOnce();
  });

  it('rejects conflicting owners and aborts timed-out actions', async () => {
    const host = setup(10);
    host.registerOwner({
      descriptor,
      initialState: state,
      handleAction: (_id, _arguments, execution) =>
        new Promise((_resolve, reject) => {
          execution.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    expect(() => host.registerOwner({ descriptor, initialState: state, handleAction: vi.fn() })).toThrow(
      /already has a live owner/u,
    );
    await expect(
      host.invoke(
        { operationId: 'operation-timeout', mode: reference(host), actionId: 'activate', arguments: {} },
        '@agimon-ai/test',
      ),
    ).rejects.toThrow(/timed out/u);
  });

  it('rejects unavailable actions and stale registrations before invoking an owner', async () => {
    const host = setup();
    const action = vi.fn(async () => undefined);
    const owner = host.registerOwner({ descriptor, initialState: state, handleAction: action });
    const mode = reference(host);
    const request = { operationId: 'operation', mode, actionId: 'activate', arguments: {} };

    await expect(host.invoke({ ...request, actionId: 'missing' }, SOURCE)).rejects.toThrow(/was not found/u);
    owner.publish({ ...state, actions: [{ id: 'activate', enabled: false, disabledReason: 'Not ready' }] });
    await expect(host.invoke(request, SOURCE)).rejects.toThrow('Not ready');
    owner.publish(state);
    owner.dispose();
    await expect(host.invoke(request, SOURCE)).rejects.toThrow(/unavailable/u);
    expect(action).not.toHaveBeenCalled();
    host.dispose();
    await expect(host.invoke(request, SOURCE)).rejects.toThrow(/disposed/u);
  });

  it('deduplicates an operation, fences conflicting requests, and aborts when its owner leaves', async () => {
    const host = setup();
    const owner = host.registerOwner({
      descriptor,
      initialState: state,
      handleAction: () => new Promise(() => undefined),
    });
    const request = { operationId: 'shared', mode: reference(host), actionId: 'activate', arguments: {} };
    const first = host.invoke(request, SOURCE);

    expect(host.invoke(request, SOURCE)).toBe(first);
    await expect(host.invoke(request, '@agimon-ai/other')).rejects.toThrow(/reused/u);
    await expect(host.invoke({ ...request, operationId: 'other' }, SOURCE)).rejects.toThrow(/active action/u);
    owner.dispose();
    await expect(first).rejects.toThrow(/aborted/u);
    host.dispose();
  });

  it('reports an owner failure and rejects actions outside the session context', async () => {
    const onError = vi.fn();
    const host = setup();
    host.registerOwner({
      descriptor: {
        ...descriptor,
        actions: [{ ...descriptor.actions[0]!, contexts: ['tui'] }],
      },
      initialState: state,
      handleAction: vi.fn(),
    });
    await expect(
      host.invoke({ operationId: 'unsupported', mode: reference(host), actionId: 'activate', arguments: {} }, SOURCE),
    ).rejects.toThrow(/unavailable in headless/u);
    host.dispose();

    const failingHost = setup();
    failingHost.registerOwner({
      descriptor,
      initialState: state,
      handleAction: () => {
        throw new Error('owner crashed');
      },
      onError,
    });
    await expect(
      failingHost.invoke(
        { operationId: 'failure', mode: reference(failingHost), actionId: 'activate', arguments: {} },
        SOURCE,
      ),
    ).rejects.toThrow('owner crashed');
    expect(onError).toHaveBeenCalledOnce();
    failingHost.dispose();
  });
});
