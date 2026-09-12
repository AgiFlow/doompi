import type { DoomHubChannelHost, DoomHubSessionScope } from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { describe, expect, it, vi } from 'vitest';
import { createComputerUseChannel } from '../../src/controllers/webComputerUseChannel';
import { COMPUTER_USE_ROUTES, type ComputerUseSessionView } from '../../src/types/computerUseApi';

const scope: DoomHubSessionScope = { sessionId: 'session-1', cwd: '/repo' };

function state(
  phase: ComputerUseSessionView['phase'],
  extra: Partial<ComputerUseSessionView> = {},
): ComputerUseSessionView {
  return { sessionId: scope.sessionId, revision: 1, wake: 1, phase, ...extra };
}

function fixture(initial: ComputerUseSessionView = state('inactive')) {
  let current = initial;
  let activation: unknown = null;
  let authorization: unknown = null;
  let pending: unknown = null;
  let listener: ((payload: unknown) => void) | undefined;
  const publish = vi.fn();
  const onNotice = vi.fn();
  const unsubscribe = vi.fn();
  const desktopRequest = vi.fn(async (_scope: DoomHubSessionScope, request: { operation: string }) => {
    if (request.operation === 'targets') return [{ id: 'screen' }, null, 'bad'];
    if (request.operation === 'activate') return { grantId: 'grant-1' };
    if (request.operation === 'status') return { ownedBySession: true };
    if (request.operation === 'stop') return { artifactId: 'artifact-1', status: 'ready' };
    return { ok: true };
  });
  const requestSessionApi = vi.fn(async (_scope: DoomHubSessionScope, request: { path: string; body?: string }) => {
    switch (request.path) {
      case COMPUTER_USE_ROUTES.hubState:
        return Response.json(current);
      case COMPUTER_USE_ROUTES.hubActivation:
        return Response.json(activation);
      case COMPUTER_USE_ROUTES.hubAuthorization:
        return Response.json(authorization);
      case COMPUTER_USE_ROUTES.hubNext: {
        const result = pending;
        pending = null;
        return Response.json(result);
      }
      case COMPUTER_USE_ROUTES.hubStop:
        current = request.body && JSON.parse(request.body).host ? state('active') : state('inactive');
        return Response.json(current);
      default:
        return Response.json({ ok: true });
    }
  });
  const host = {
    directEvents: {
      publish: vi.fn(),
      subscribe: vi.fn((_type: string, _sessionId: string, callback: (payload: unknown) => void) => {
        listener = callback;
        return unsubscribe;
      }),
      close: vi.fn(),
    },
    publish,
    onNotice,
    requestSessionApi,
    computerUse: { available: true, request: desktopRequest },
  } as unknown as DoomHubChannelHost;
  const channel = createComputerUseChannel();
  const source = channel.start(host);
  return {
    channel,
    source,
    host,
    publish,
    onNotice,
    unsubscribe,
    desktopRequest,
    requestSessionApi,
    announce: (payload: unknown) => listener?.(payload),
    setState: (value: ComputerUseSessionView) => (current = value),
    setActivation: (value: unknown) => (activation = value),
    setAuthorization: (value: unknown) => (authorization = value),
    setPending: (value: unknown) => (pending = value),
  };
}

describe('computer-use hub channel', () => {
  it('publishes session state, filters Desktop targets, and releases a removed session', async () => {
    const test = fixture();
    test.source.sessionAdded?.(scope);
    await vi.waitFor(() =>
      expect(test.publish).toHaveBeenCalledWith(scope.sessionId, { state: state('inactive'), targets: [] }),
    );
    test.channel.receive?.(scope, { action: 'targets' }, { connectionId: 'c1' });
    await vi.waitFor(() =>
      expect(test.source.payloadFor(scope)).toEqual({ state: state('inactive'), targets: [{ id: 'screen' }] }),
    );
    test.channel.receive?.(scope, { action: 'unknown' }, { connectionId: 'c1' });
    test.announce({ sessionId: 'other', revision: 2, wake: 2, phase: 'active' });
    expect(test.source.payloadFor(scope)).toEqual({ state: state('inactive'), targets: [{ id: 'screen' }] });
    test.source.sessionRemoved?.(scope.sessionId);
    expect(test.unsubscribe).toHaveBeenCalledOnce();
    expect(test.source.payloadFor(scope)).toBeUndefined();
    test.source.close();
  });

  it('activates a pending grant, handles a broker action, and stops on removal', async () => {
    const test = fixture(state('awaiting_confirmation'));
    test.setActivation({ requestId: 'request-1' });
    test.setAuthorization({ grantId: 'grant-1' });
    test.setPending({ id: 'pending-1', operation: 'act', grantId: 'grant-1', sequence: 2, payload: { click: true } });
    test.source.sessionAdded?.(scope);
    await vi.waitFor(() =>
      expect(test.desktopRequest).toHaveBeenCalledWith(scope, expect.objectContaining({ operation: 'act' })),
    );
    expect(test.source.payloadFor(scope)).toMatchObject({ state: { phase: 'active' }, targets: [] });
    expect(test.requestSessionApi).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ path: COMPUTER_USE_ROUTES.hubComplete, method: 'POST' }),
    );
    test.source.sessionRemoved?.(scope.sessionId);
    await vi.waitFor(() =>
      expect(test.desktopRequest).toHaveBeenCalledWith(scope, { operation: 'stop', payload: { grantId: 'grant-1' } }),
    );
    test.source.close();
  });

  it('expires an active grant and processes explicit stop commands', async () => {
    const test = fixture(state('active', { expiresAt: Date.now() - 1 }));
    test.setAuthorization({ grantId: 'grant-1' });
    test.source.sessionAdded?.(scope);
    await vi.waitFor(() => expect(test.source.payloadFor(scope)).toMatchObject({ state: { phase: 'inactive' } }));
    test.setState(state('stopping'));
    test.channel.receive?.(scope, { action: 'stop' }, { connectionId: 'c1' });
    await vi.waitFor(() =>
      expect(test.requestSessionApi).toHaveBeenCalledWith(
        scope,
        expect.objectContaining({ path: COMPUTER_USE_ROUTES.hubStop, method: 'POST' }),
      ),
    );
    test.source.close();
  });

  it('reports an invalid state and ignores events after closing', async () => {
    const test = fixture();
    test.setState({} as ComputerUseSessionView);
    test.source.sessionAdded?.(scope);
    await vi.waitFor(() =>
      expect(test.onNotice).toHaveBeenCalledWith(expect.stringContaining('invalid session state')),
    );
    test.source.close();
    expect(test.source.payloadFor(scope)).toBeUndefined();
  });
});
