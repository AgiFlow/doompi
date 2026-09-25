import { describe, expect, it, vi } from 'vitest';

import type { VoiceMediaBroker } from '../src/services/clientMediaApi';
import { GlobalLiveCompanion } from '../src/services/globalLiveCompanion';
import type { LiveAgentRoute } from '../src/services/globalLiveCompanion/type';
import type { RealtimeDeliveryOutcome } from '../src/types/realtime';

function route(sessionId: string, generation: number): LiveAgentRoute {
  return {
    scope: { sessionId, cwd: `/work/${sessionId}` },
    activationId: 'activation',
    sessionIncarnation: `incarnation-${sessionId}`,
    generation,
    transactionId: 'transaction',
    cursor: 0,
  };
}

// Isolate route staging: a provider call is not required to prove that the
// companion does not admit a validated request to the wrong agent.
function fixture() {
  const source = route('source', 1);
  const target = route('target', 2);
  let resolveTarget!: (target: LiveAgentRoute) => void;
  const pending = new Promise<LiveAgentRoute>((resolve) => {
    resolveTarget = resolve;
  });
  const send = vi.fn(async () => undefined);
  const onNotice = vi.fn();
  const companion = Object.create(GlobalLiveCompanion.prototype) as GlobalLiveCompanion;
  const internals = companion as unknown as Record<string, unknown>;
  internals.route = source;
  internals.transfer = undefined;
  internals.routeGeneration = 1;
  internals.stopped = false;
  internals.selectedRoute = source;
  internals.selecting = Promise.resolve();
  internals.admitted = new Map();
  internals.options = { broker: { live: { send } }, onNotice };
  internals.live = { state: 'active', trackAgentRequest: vi.fn(), deactivate: vi.fn(async () => undefined) };
  internals.prepare = vi.fn(() => pending);
  internals.pollAgentResults = vi.fn(async () => false);
  internals.agentRequest = vi.fn(async () => ({}));
  const admitToRoute = vi.fn<() => Promise<RealtimeDeliveryOutcome>>(async () => 'submitted');
  internals.admitToRoute = admitToRoute;
  const admit = (id: string) =>
    (internals.admit as (id: string, transcript: string) => Promise<string>).call(companion, id, 'please help');
  return { companion, internals, source, target, resolveTarget, send, onNotice, admitToRoute, admit };
}

describe('global Voice transfer holding', () => {
  it('waits for active route selection even before the first selection request starts', async () => {
    const test = fixture();
    test.internals.selectedRoute = undefined;
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    test.internals.activationSelection = { route: test.source, promise, resolve: release };
    const request = test.admit('first-live-request');
    await Promise.resolve();
    expect(test.admitToRoute).not.toHaveBeenCalled();
    test.internals.selectedRoute = test.source;
    release();
    expect(await request).toBe('submitted');
    test.internals.activationSelection = undefined;
    expect(await test.admit('next-live-request')).toBe('submitted');
  });

  it('binds source selection to its catalog and serializes refresh before revocation', async () => {
    const test = fixture();
    const coordinator = {
      liveCatalog: vi.fn(() => ({ revision: 'catalog-2', targets: [{ order: 1, label: 'Target' }] })),
    };
    test.internals.coordinator = coordinator;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async (_route: unknown, path: string) => {
      if (path === '/live/agent/select') await pending;
      return {};
    });
    test.internals.agentRequest = request;
    const select = (test.internals.selectRoute as (route: LiveAgentRoute) => Promise<void>).call(
      test.companion,
      test.source,
    );
    const refresh = test.companion.refreshSelectedCatalog();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const stop = test.companion.stop();
    expect(test.internals.route).toBeUndefined();
    release();
    await select;
    await refresh;
    await stop;
    expect(request.mock.calls.filter(([, path]) => path === '/live/agent/select')).toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      test.source,
      '/live/agent/select',
      'POST',
      expect.objectContaining({ nativeTransferAllowed: true }),
    );
    expect(request).toHaveBeenLastCalledWith(test.source, '/live/agent/revoke', 'POST', expect.any(Object));
    expect(coordinator.liveCatalog).toHaveBeenCalledWith('source');
    expect(test.internals.selectedRoute).toBeUndefined();
  });

  it('rejects changed route identity and stale catalog before requesting a native transfer', () => {
    const test = fixture();
    const input = {
      sourceSessionId: 'source',
      activationId: test.source.activationId,
      routeGeneration: test.source.generation,
      sessionIncarnation: test.source.sessionIncarnation,
      ordinal: 1,
      catalogRevision: 'catalog-2',
    };
    const resolve = vi.fn(() => 'target');
    expect(() => test.companion.nativeTransfer({ ...input, activationId: 'old' }, resolve)).toThrow('no longer owns');
    expect(() => test.companion.nativeTransfer({ ...input, routeGeneration: 2 }, resolve)).toThrow('no longer owns');
    expect(() => test.companion.nativeTransfer({ ...input, sessionIncarnation: 'old' }, resolve)).toThrow(
      'no longer owns',
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(() => test.companion.nativeTransfer(input, () => undefined)).toThrow('catalog or source route is stale');
    expect(() => test.companion.nativeTransfer(input, () => 'source')).toThrow('catalog or source route is stale');
    expect(test.internals.transfer).toBeUndefined();
  });

  it('does not admit a source request until route selection acknowledges, and fails closed on rejection', async () => {
    const test = fixture();
    test.internals.selectedRoute = undefined;
    let accept!: () => void;
    test.internals.selecting = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const first = test.admit('before-selection');
    await Promise.resolve();
    expect(test.admitToRoute).not.toHaveBeenCalled();
    test.internals.selectedRoute = test.source;
    accept();
    expect(await first).toBe('submitted');
    expect(test.admitToRoute).toHaveBeenCalledOnce();
    test.internals.selectedRoute = undefined;
    test.internals.selecting = Promise.reject(new Error('selection failed'));
    expect(await test.admit('failed-selection')).toBe('rejected');
  });
  it('acknowledges a native transfer before the source run settles, then commits after its ACK', async () => {
    const test = fixture();
    let releaseRun!: () => void;
    const running = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const poll = vi.fn(async () => {
      await running;
      return false;
    });
    test.internals.pollAgentResults = poll;
    const input = {
      sourceSessionId: 'source',
      activationId: test.source.activationId,
      routeGeneration: test.source.generation,
      sessionIncarnation: test.source.sessionIncarnation,
      ordinal: 1,
      catalogRevision: 'catalog-1',
    };
    expect(test.companion.nativeTransfer(input, () => 'target')).toEqual({ requested: true });
    expect(() => test.companion.nativeTransfer(input, () => 'target')).toThrow('no longer owns');
    expect(test.internals.route).toBe(test.source);
    test.resolveTarget(test.target);
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    expect(test.internals.route).toBe(test.source);
    releaseRun();
    await vi.waitFor(() => expect(test.internals.route).toBe(test.target));
    expect(test.internals.agentRequest).toHaveBeenCalledWith(
      test.source,
      '/live/agent/fence',
      'POST',
      expect.any(Object),
    );
    expect(test.internals.agentRequest).toHaveBeenCalledWith(
      test.target,
      '/live/agent/select',
      'POST',
      expect.any(Object),
    );
    expect(() => test.companion.nativeTransfer(input, () => 'target')).toThrow('no longer owns');
  });
  it('holds requests for the intended target during preparation, then admits after the source fence', async () => {
    const test = fixture();
    const handoff = test.companion.handoff('source', 'target', 'transaction');
    expect(await test.admit('request-1')).toBe('buffered');
    expect(test.internals.transfer).toMatchObject({
      targetSessionId: 'target',
      held: [{ requestId: 'request-1', destination: 'target', transcript: 'please help' }],
    });
    expect(test.admitToRoute).not.toHaveBeenCalled();
    test.resolveTarget(test.target);
    expect(await handoff).toBe(true);
    expect(test.admitToRoute).toHaveBeenCalledWith(test.target, 'request-1', 'please help');
    expect(test.internals.agentRequest).toHaveBeenCalledWith(
      test.source,
      '/live/agent/fence',
      'POST',
      expect.any(Object),
    );
    expect(test.internals.route).toBe(test.target);
    expect(test.internals.transfer).toBeUndefined();
    expect(test.send).toHaveBeenCalledOnce();
  });

  it('retains bounded held requests when target admission is uncertain and never reroutes to source', async () => {
    const test = fixture();
    test.admitToRoute.mockResolvedValueOnce('uncertain');
    const handoff = test.companion.handoff('source', 'target', 'transaction');
    for (let index = 0; index < 16; index++) expect(await test.admit(`request-${index}`)).toBe('buffered');
    expect(await test.admit('overflow')).toBe('rejected');
    test.resolveTarget(test.target);
    expect(await handoff).toBe(false);
    expect(test.internals.transfer).toMatchObject({
      targetSessionId: 'target',
      held: expect.arrayContaining([
        { requestId: 'request-0', transcript: 'please help', transactionId: 'transaction', destination: 'target' },
      ]),
    });
    expect(test.admitToRoute).toHaveBeenCalledOnce();
    expect(test.admitToRoute).not.toHaveBeenCalledWith(test.source, expect.anything(), expect.anything());
    expect(test.send).not.toHaveBeenCalled();
    expect(test.onNotice).toHaveBeenCalledWith(expect.stringContaining('held requests remain for target'));
  });

  it('revokes held admission synchronously on explicit stop even if target preparation is pending', async () => {
    const test = fixture();
    const handoff = test.companion.handoff('source', 'target', 'transaction');
    expect(await test.admit('request-1')).toBe('buffered');
    const stopped = test.companion.stop();
    expect(test.internals.route).toBeUndefined();
    expect(test.internals.transfer).toBeUndefined();
    expect(await test.admit('request-2')).toBe('rejected');
    test.resolveTarget(test.target);
    expect(await handoff).toBe(false);
    await stopped;
    expect(test.admitToRoute).not.toHaveBeenCalled();
    expect(test.onNotice).toHaveBeenCalledWith(
      expect.stringContaining('Explicit Voice stop discarded 1 held requests for target'),
    );
  });
  it('reserves exact provider IDs before native admission and never repeats a durable receipt', async () => {
    const test = fixture();
    const reserve = vi.fn(async (): Promise<unknown> => ({ kind: 'reserved', token: 'token' }));
    const finish = vi.fn(async () => ({ outcome: 'admitted' }));
    (test.internals.options as Record<string, unknown>).receipts = { reserve, finish };
    delete test.internals.admitToRoute;
    const native = vi.fn(async (_route: unknown, _path: string, _method: string, body: { requestId: string }) => ({
      admitted: true,
      requestId: body.requestId,
    }));
    test.internals.agentRequest = native;
    const admit = (id: string) =>
      (
        test.internals.admitToRoute as (route: LiveAgentRoute, requestId: string, transcript: string) => Promise<string>
      ).call(test.companion, test.source, id, 'exact words');
    expect(await admit('provider-1')).toBe('submitted');
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'voice.admission', requestId: 'provider-1', activationId: 'activation' }),
    );
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ token: 'token', outcome: 'admitted' }));
    reserve.mockResolvedValueOnce({ kind: 'existing', receipt: { outcome: 'admitted' } });
    expect(await admit('provider-1')).toBe('submitted');
    expect(native).toHaveBeenCalledOnce();
    reserve.mockResolvedValueOnce({ kind: 'conflict', receipt: { outcome: 'admitted' } });
    expect(await admit('provider-conflict')).toBe('rejected');
    native.mockRejectedValueOnce(new Error('uncertain transport'));
    expect(await admit('provider-uncertain')).toBe('uncertain');
    expect(finish).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'uncertain' }));
    expect(native).toHaveBeenCalledTimes(2);
  });

  it('publishes one correlated Pi result and retires it only after agent acknowledgement', async () => {
    const test = fixture();
    const reserve = vi.fn(async (): Promise<unknown> => ({ kind: 'reserved', token: 'publication-token' }));
    const finish = vi.fn(async () => ({ outcome: 'admitted' }));
    (test.internals.options as Record<string, unknown>).receipts = { reserve, finish };
    const publishAgentResult = vi.fn(async () => true);
    test.internals.live = { ...(test.internals.live as object), publishAgentResult };
    delete test.internals.pollAgentResults;
    const event = {
      sequence: 1,
      requestIds: ['provider-1'],
      runId: 'run-1',
      resultId: 'result-1',
      assistantText: 'Native answer.',
      status: 'completed',
      sourceSessionId: 'source',
      sessionIncarnation: test.source.sessionIncarnation,
    };
    const agentRequest = vi.fn(async (_route: unknown, path: string) =>
      path.startsWith('/live/agent/results?') ? { cursor: 1, activeRuns: [], events: [event] } : undefined,
    );
    test.internals.agentRequest = agentRequest;
    (test.internals.admitted as Map<string, LiveAgentRoute>).set('provider-1', test.source);
    const poll = () =>
      (test.internals.pollAgentResults as (route: LiveAgentRoute) => Promise<boolean>).call(
        test.companion,
        test.source,
      );
    expect(await poll()).toBe(false);
    expect(publishAgentResult).toHaveBeenCalledWith('result-1', 'Native answer.', ['provider-1']);
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'voice.publication', outcome: 'admitted' }),
    );
    expect(agentRequest).toHaveBeenCalledWith(
      test.source,
      '/live/agent/results/ack',
      'POST',
      expect.objectContaining({ cursor: 1 }),
    );
    expect(test.source.cursor).toBe(1);
    expect((test.internals.admitted as Map<string, LiveAgentRoute>).size).toBe(0);
    reserve.mockResolvedValueOnce({ kind: 'existing', receipt: { outcome: 'admitted' } });
    await (test.internals.publishResult as (route: LiveAgentRoute, event: unknown) => Promise<void>).call(
      test.companion,
      test.source,
      event,
    );
    expect(publishAgentResult).toHaveBeenCalledOnce();
  });
  it('prepares only a locally admitted Pi target with a matching native incarnation', async () => {
    const test = fixture();
    delete test.internals.prepare;
    test.internals.hub = { sessions: () => [test.source.scope] };
    test.internals.agentRequest = vi.fn(async (_route: unknown, path: string) =>
      path === '/live/agent'
        ? { available: true, sourceSessionId: 'source', sessionIncarnation: 'incarnation-source' }
        : { sourceSessionId: 'source', sessionIncarnation: 'incarnation-source', routeGeneration: 3 },
    );
    const prepare = (sessionId: string) =>
      (
        test.internals.prepare as (
          sessionId: string,
          activationId: string,
          generation: number,
          transactionId: string,
        ) => Promise<LiveAgentRoute>
      ).call(test.companion, sessionId, 'activation', 3, 'transaction');
    await expect(prepare('source')).resolves.toMatchObject({
      scope: test.source.scope,
      generation: 3,
      sessionIncarnation: 'incarnation-source',
    });
    await expect(prepare('unknown')).rejects.toThrow('not available on this host');
    test.internals.agentRequest = vi.fn(async () => ({ available: false }));
    await expect(prepare('source')).rejects.toThrow('cannot accept live Voice');
  });

  it('rejects mismatched results and fails closed on uncertain publication', async () => {
    const test = fixture();
    delete test.internals.pollAgentResults;
    test.internals.agentRequest = vi.fn(async () => ({
      cursor: 1,
      activeRuns: [],
      events: [{ sequence: 1, sourceSessionId: 'wrong', runId: 'run', resultId: 'result', requestIds: [] }],
    }));
    await expect(
      (test.internals.pollAgentResults as (route: LiveAgentRoute) => Promise<boolean>).call(
        test.companion,
        test.source,
      ),
    ).rejects.toThrow('identity is invalid');
    const reserve = vi.fn(async (): Promise<unknown> => ({ kind: 'conflict', receipt: { outcome: 'admitted' } }));
    (test.internals.options as Record<string, unknown>).receipts = { reserve, finish: vi.fn() };
    await expect(
      (test.internals.publishResult as (route: LiveAgentRoute, event: unknown) => Promise<void>).call(
        test.companion,
        test.source,
        {
          sequence: 1,
          sourceSessionId: 'source',
          sessionIncarnation: 'incarnation-source',
          runId: 'run',
          resultId: 'result',
          requestIds: [],
          status: 'failed',
        },
      ),
    ).rejects.toThrow('conflicts');
    reserve.mockResolvedValueOnce({ kind: 'existing', receipt: { outcome: 'uncertain' } });
    await expect(
      (test.internals.publishResult as (route: LiveAgentRoute, event: unknown) => Promise<void>).call(
        test.companion,
        test.source,
        {
          sequence: 1,
          sourceSessionId: 'source',
          sessionIncarnation: 'incarnation-source',
          runId: 'run',
          resultId: 'result',
          requestIds: [],
          status: 'failed',
        },
      ),
    ).rejects.toThrow('uncertain');
  });

  it('controls the one global companion and revokes its route synchronously on end', async () => {
    const test = fixture();
    const setMicrophoneMuted = vi.fn();
    const interruptSpeech = vi.fn();
    test.internals.live = {
      ...(test.internals.live as object),
      microphoneMuted: false,
      setMicrophoneMuted,
      interruptSpeech,
    };
    const options = test.internals.options as Record<string, unknown>;
    options.broker = { live: { send: test.send }, browserConnected: true, realtimeActive: true };
    expect(test.companion.mediaReady()).toBe(true);
    expect(test.companion.status).toMatchObject({ activeSessionId: 'source', media: { client: true, realtime: true } });
    await test.companion.control({ action: 'mute' });
    await test.companion.control({ action: 'unmute' });
    await test.companion.control({ action: 'interrupt' });
    expect(setMicrophoneMuted.mock.calls).toEqual([[true], [false]]);
    expect(interruptSpeech).toHaveBeenCalledOnce();
    await expect(test.companion.control({ action: 'activate' })).rejects.toThrow('Select an admitted Pi session');
    await expect(test.companion.control({ action: 'activate', sessionId: 'target' })).rejects.toThrow(
      'prepared Voice transfer',
    );
    await test.companion.control({ action: 'end' });
    expect(test.companion.mediaReady()).toBe(false);
    expect(test.internals.route).toBeUndefined();
    expect(test.internals.admitted).toEqual(new Map());
  });
  it('keeps public live controls scoped to validated global actions', async () => {
    const broker = {
      browserConnected: false,
      realtimeActive: false,
      live: { start: vi.fn(), stop: vi.fn(), poll: vi.fn(), send: vi.fn() },
      close: vi.fn(),
    } as unknown as VoiceMediaBroker;
    const companion = new GlobalLiveCompanion({ broker, onNotice: vi.fn() });
    const api = companion.api.start({} as never);
    const request = (path: string, method = 'GET', body?: unknown) =>
      api.fetch(
        new Request(`http://voice.test${path}`, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    expect((await request('/live/status')).status).toBe(200);
    expect((await request('/live/unknown')).status).toBe(404);
    expect((await request('/live/control', 'GET')).status).toBe(404);
    expect((await request('/live/control', 'POST', { action: 'untrusted' })).status).toBe(400);
    expect((await request('/live/control', 'POST', { action: 'activate' })).status).toBe(400);
    expect((await request('/live/control', 'POST', { action: 'activate', sessionId: 'target' })).status).toBe(409);
    expect((await request('/live/control', 'POST', { action: 'end' })).status).toBe(200);
    api.close();
    await companion.close();
  });

  it('does not admit when a route is revoked, receipts are missing, or a prior outcome is uncertain', async () => {
    const test = fixture();
    delete test.internals.admitToRoute;
    const admit = (id: string) =>
      (
        test.internals.admitToRoute as (route: LiveAgentRoute, requestId: string, transcript: string) => Promise<string>
      ).call(test.companion, test.source, id, 'request');
    expect(await admit('no-receipts')).toBe('rejected');
    const reserve = vi.fn(async (): Promise<unknown> => ({ kind: 'existing', receipt: { outcome: 'rejected' } }));
    const finish = vi.fn(async () => ({ outcome: 'rejected' }));
    (test.internals.options as Record<string, unknown>).receipts = { reserve, finish };
    expect(await admit('rejected')).toBe('rejected');
    reserve.mockResolvedValueOnce({ kind: 'existing', receipt: { outcome: 'reserved' } });
    expect(await admit('uncertain')).toBe('uncertain');
    reserve.mockImplementationOnce(async () => {
      test.internals.route = undefined;
      return { kind: 'reserved', token: 'revoked-token' };
    });
    expect(await admit('revoked')).toBe('rejected');
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'rejected', token: 'revoked-token' }));
    expect(await admit('still-revoked')).toBe('rejected');
  });

  it('refuses malformed source results and uncertain provider publication', async () => {
    const test = fixture();
    delete test.internals.pollAgentResults;
    test.internals.agentRequest = vi.fn(async () => ({ cursor: 'invalid', activeRuns: [], events: [] }));
    const poll = () =>
      (test.internals.pollAgentResults as (route: LiveAgentRoute) => Promise<boolean>).call(
        test.companion,
        test.source,
      );
    await expect(poll()).rejects.toThrow('results are invalid');
    const reserve = vi.fn(async (): Promise<unknown> => ({ kind: 'reserved', token: 'token' }));
    const finish = vi.fn(async () => ({ outcome: 'uncertain' }));
    (test.internals.options as Record<string, unknown>).receipts = { reserve, finish };
    test.internals.live = { ...(test.internals.live as object), publishAgentResult: vi.fn(async () => false) };
    await expect(
      (test.internals.publishResult as (route: LiveAgentRoute, event: unknown) => Promise<void>).call(
        test.companion,
        test.source,
        {
          sequence: 1,
          sourceSessionId: 'source',
          sessionIncarnation: 'incarnation-source',
          runId: 'run',
          resultId: 'result',
          requestIds: [],
          status: 'failed',
        },
      ),
    ).rejects.toThrow('publication is uncertain');
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'uncertain' }));
  });
});
