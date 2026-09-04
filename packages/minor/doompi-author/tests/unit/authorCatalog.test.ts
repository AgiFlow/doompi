import { describe, expect, it } from 'vitest';
import { parseDescribeAuthorToolsInput, parseUseAuthorToolInput } from '../../src/schemas/authorTools.ts';
import { createAuthorBridgeState } from '../../src/services/authorBridgeState.ts';

const scheduleTimeout = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

const tools = [
  {
    name: 'replace_selection',
    label: 'Replace selection',
    description: 'Replace the selected document range.',
    inputSchema: { type: 'object' },
  },
];

function registered() {
  const tokens = ['owner', 'catalog', 'request'];
  const state = createAuthorBridgeState({ now: Date.now, issueToken: () => tokens.shift()!, scheduleTimeout });
  const registration = state.register('binding', 1);
  const catalog = state.catalog('binding', 1, registration.ownerToken, tools);
  return { state, registration, catalog };
}

describe('the Author bridge catalog', () => {
  it('issues server tokens and invokes exactly one browser capability', async () => {
    const { state, registration, catalog } = registered();
    expect(state.describe()).toEqual({ catalogToken: 'catalog', tools });

    const invocation = state.invoke({ catalogToken: 'catalog', name: tools[0]!.name, arguments: { text: 'x' } });
    const request = await state.next('binding', 1, registration.ownerToken);
    expect(request).toMatchObject({ kind: 'request', catalogToken: catalog.catalogToken, arguments: { text: 'x' } });
    state.result('binding', 1, registration.ownerToken, 'catalog', request.requestId, { accepted: true });
    await expect(invocation).resolves.toEqual({
      catalogToken: 'catalog',
      name: tools[0]!.name,
      result: { accepted: true },
    });
  });

  it('allows one pending request and fences stale binding, generation, catalog, and request values', async () => {
    const { state, registration } = registered();
    const invocation = state.invoke({ catalogToken: 'catalog', name: tools[0]!.name, arguments: {} });
    const request = await state.next('binding', 1, registration.ownerToken);
    await expect(state.invoke({ catalogToken: 'catalog', name: tools[0]!.name, arguments: {} })).rejects.toThrow(
      'already pending',
    );
    expect(() => state.result('other', 1, registration.ownerToken, 'catalog', request.requestId, null)).toThrow(
      'binding',
    );
    expect(() => state.result('binding', 2, registration.ownerToken, 'catalog', request.requestId, null)).toThrow(
      'binding',
    );
    expect(() => state.result('binding', 1, registration.ownerToken, 'old', request.requestId, null)).toThrow(
      'catalog',
    );
    expect(() => state.result('binding', 1, registration.ownerToken, 'catalog', 'old', null)).toThrow('request');
    state.result('binding', 1, registration.ownerToken, 'catalog', request.requestId, null);
    await invocation;
  });

  it('delivers cancellation and tombstones late results', async () => {
    const { state, registration } = registered();
    const controller = new AbortController();
    const invocation = state.invoke(
      { catalogToken: 'catalog', name: tools[0]!.name, arguments: {} },
      controller.signal,
    );
    const request = await state.next('binding', 1, registration.ownerToken);
    controller.abort();
    await expect(invocation).rejects.toThrow('cancelled');
    await expect(state.next('binding', 1, registration.ownerToken)).resolves.toMatchObject({
      kind: 'cancel',
      requestId: request.requestId,
    });
    expect(() => state.result('binding', 1, registration.ownerToken, 'catalog', request.requestId, null)).toThrow(
      'already cancelled',
    );
  });

  it('expires ownership leases and rejects competing bindings', () => {
    let now = 0;
    const state = createAuthorBridgeState({ now: () => now, issueToken: () => 'owner', scheduleTimeout });
    state.register('first', 1);
    expect(() => state.register('second', 1)).toThrow('owns the lease');
    now = 10_001;
    expect(state.register('second', 1)).toMatchObject({ kind: 'accepted', ownerToken: 'owner' });
  });
});

describe('the Author facade trust boundary', () => {
  it('parses the JSON strings supplied by Pi with the core facade shape', () => {
    expect(parseDescribeAuthorToolsInput('{}')).toEqual({});
    expect(parseUseAuthorToolInput('{"catalogToken":"token","name":"replace_selection","arguments":{}}')).toEqual({
      catalogToken: 'token',
      name: 'replace_selection',
      arguments: {},
    });
    expect(() => parseUseAuthorToolInput({ catalogToken: 'token', name: 'viewport:replace', arguments: {} })).toThrow();
    expect(() =>
      parseUseAuthorToolInput({ catalogToken: 'token', name: 'replace_selection', arguments: null }),
    ).toThrow();
  });
});
