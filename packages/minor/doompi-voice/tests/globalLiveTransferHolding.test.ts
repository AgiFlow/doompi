import { describe, expect, it, vi } from 'vitest';

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
});
