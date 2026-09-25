import { describe, expect, it, vi } from 'vitest';

import { LiveAgentSession } from '../src/services/liveAgentSession';

const base = 'http://voice.test';
const headers = { authorization: 'Bearer hub-secret' };
function get(path: string, authorized = true): Request {
  return new Request(`${base}${path}`, { headers: authorized ? headers : {} });
}
function post(path: string, body: object): Request {
  return new Request(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('native Pi live agent adapter', () => {
  it('admits through the real session callback, correlates native run and result, then fences the source', async () => {
    const admit = vi.fn(async (_text: string) => undefined);
    const agent = new LiveAgentSession('source', 'hub-secret', admit);
    expect((await agent.fetch(get('/live/agent', false))).status).toBe(404);
    const readiness = await agent.fetch(get('/live/agent'));
    expect(readiness.status).toBe(200);
    const incarnation = agent.sessionIncarnation;
    const route = {
      activationId: 'activation',
      routeGeneration: 1,
      transactionId: 'transaction',
      sessionIncarnation: incarnation,
    };
    expect((await agent.fetch(post('/live/agent/prepare', route))).status).toBe(200);
    expect(
      (
        await agent.fetch(
          post('/live/agent/admit', {
            ...route,
            requestId: 'provider-1',
            transcript: 'ask the agent',
            intent: 'immediate',
          }),
        )
      ).status,
    ).toBe(200);
    expect(admit).toHaveBeenCalledExactlyOnceWith('ask the agent');
    agent.onRunStart({ runId: 'native-run-1' });
    agent.onRunStart({ runId: 'native-run-1' }); // resume is not another admission
    agent.onTurnEnd({
      runId: 'native-run-1',
      turnId: 'tool-turn',
      message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Internal tool work.' }] },
    });
    agent.onTurnEnd({
      runId: 'native-run-1',
      turnId: 'user-turn',
      message: { role: 'user', content: [{ type: 'text', text: 'User input.' }] },
    });
    agent.onTurnEnd({
      runId: 'native-run-1',
      turnId: 'turn-1',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Native answer.' }] },
    });
    agent.onSettled({ runId: 'native-run-1' });
    agent.onSettled({ runId: 'unknown-run' });
    const results = await agent.fetch(
      get(`/live/agent/results?activationId=activation&routeGeneration=1&sessionIncarnation=${incarnation}&after=0`),
    );
    expect(await results.json()).toMatchObject({
      cursor: 1,
      activeRuns: [],
      events: [
        {
          requestIds: ['provider-1'],
          runId: 'native-run-1',
          turnId: 'turn-1',
          assistantText: 'Native answer.',
          sourceSessionId: 'source',
          sessionIncarnation: incarnation,
          status: 'completed',
        },
      ],
    });
    expect((await agent.fetch(post('/live/agent/fence', route))).status).toBe(409);
    expect((await agent.fetch(post('/live/agent/results/ack', { ...route, cursor: 1 }))).status).toBe(204);
    expect((await agent.fetch(post('/live/agent/fence', route))).status).toBe(204);
    expect(
      (
        await agent.fetch(
          post('/live/agent/admit', { ...route, requestId: 'late', transcript: 'no', intent: 'immediate' }),
        )
      ).status,
    ).toBe(409);
    agent.close();
    expect((await agent.fetch(get('/live/agent'))).status).toBe(503);
  });

  it('does not report uncertain native admission as accepted', async () => {
    const agent = new LiveAgentSession('source', 'hub-secret', async () => {
      throw new Error('native error');
    });
    const route = {
      activationId: 'activation',
      routeGeneration: 1,
      transactionId: 'transaction',
      sessionIncarnation: agent.sessionIncarnation,
    };
    await agent.fetch(post('/live/agent/prepare', route));
    expect(
      (
        await agent.fetch(
          post('/live/agent/admit', { ...route, requestId: 'provider-1', transcript: 'hello', intent: 'immediate' }),
        )
      ).status,
    ).toBe(503);
    agent.onRunStart({ runId: 'unrelated-run' });
    agent.onSettled({ runId: 'unrelated-run' });
    const results = await agent.fetch(
      get(
        `/live/agent/results?activationId=activation&routeGeneration=1&sessionIncarnation=${agent.sessionIncarnation}&after=0`,
      ),
    );
    expect(await results.json()).toMatchObject({ cursor: 0, events: [] });
  });
  it('rejects stale routes, malformed admission, and premature fences while retaining aborted results', async () => {
    const agent = new LiveAgentSession(
      'source',
      'hub-secret',
      vi.fn(async () => undefined),
    );
    const route = {
      activationId: 'activation',
      routeGeneration: 1,
      transactionId: 'transfer',
      sessionIncarnation: agent.sessionIncarnation,
    };
    expect((await agent.fetch(post('/live/agent/prepare', { ...route, routeGeneration: 0 }))).status).toBe(400);
    expect((await agent.fetch(post('/live/agent/prepare', route))).status).toBe(200);
    expect((await agent.fetch(post('/live/agent/prepare', route))).status).toBe(200);
    expect((await agent.fetch(post('/live/agent/admit', { ...route, activationId: 'stale' }))).status).toBe(409);
    expect(
      (
        await agent.fetch(
          post('/live/agent/admit', { ...route, requestId: 'invalid/id', transcript: 'words', intent: 'immediate' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await agent.fetch(
          post('/live/agent/admit', { ...route, requestId: 'provider-1', transcript: '', intent: 'immediate' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await agent.fetch(
          post('/live/agent/admit', { ...route, requestId: 'provider-1', transcript: 'words', intent: 'follow-up' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await agent.fetch(
          post('/live/agent/admit', { ...route, requestId: 'provider-1', transcript: 'words', intent: 'immediate' }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await agent.fetch(
          post('/live/agent/admit', { ...route, requestId: 'provider-1', transcript: 'words', intent: 'immediate' }),
        )
      ).status,
    ).toBe(409);
    expect((await agent.fetch(post('/live/agent/fence', route))).status).toBe(409);
    agent.onRunStart({ runId: 'native-run' });
    agent.onTurnEnd({
      runId: 'native-run',
      turnId: 'turn-1',
      message: { role: 'assistant', stopReason: 'aborted', content: [] },
    });
    agent.onSettled({ runId: 'native-run' });
    const resultsPath = `/live/agent/results?activationId=activation&routeGeneration=1&sessionIncarnation=${agent.sessionIncarnation}`;
    expect((await agent.fetch(get(`${resultsPath}&after=-1`))).status).toBe(400);
    expect(await (await agent.fetch(get(`${resultsPath}&after=0`))).json()).toMatchObject({
      events: [{ status: 'aborted', requestIds: ['provider-1'] }],
    });
    expect((await agent.fetch(post('/live/agent/results/ack', { ...route, cursor: 2 }))).status).toBe(400);
    expect((await agent.fetch(post('/live/agent/fence', route))).status).toBe(409);
    expect((await agent.fetch(post('/live/agent/results/ack', { ...route, cursor: 1 }))).status).toBe(204);
    expect((await agent.fetch(post('/live/agent/fence', { ...route, transactionId: 'wrong' }))).status).toBe(409);
    expect((await agent.fetch(post('/live/agent/fence', route))).status).toBe(204);
    agent.close();
  });

  it('selects only the prepared route and removes tool authority on fence or revoke', async () => {
    const changed = vi.fn();
    const agent = new LiveAgentSession(
      'source',
      'hub-secret',
      vi.fn(async () => undefined),
      changed,
    );
    const first = {
      activationId: 'activation',
      routeGeneration: 1,
      transactionId: 'first',
      sessionIncarnation: agent.sessionIncarnation,
    };
    const second = { ...first, routeGeneration: 2, transactionId: 'second' };
    const catalog = { revision: 'catalog-1', targets: [{ order: 1, label: 'Target' }] };
    expect((await agent.fetch(post('/live/agent/prepare', first))).status).toBe(200);
    expect(agent.selectedRoute).toBeUndefined();
    expect((await agent.fetch(post('/live/agent/select', { ...first, transactionId: 'stale' }))).status).toBe(409);
    expect((await agent.fetch(post('/live/agent/select', first))).status).toBe(400);
    for (const invalid of [
      { revision: '', targets: [] },
      { revision: 'catalog-1', targets: 'not a catalog' },
      { revision: 'catalog-1', targets: Array(257).fill({ order: 1, label: 'Target' }) },
      { revision: 'catalog-1', targets: [null] },
      { revision: 'catalog-1', targets: [{ order: 1.5, label: 'Target' }] },
      { revision: 'catalog-1', targets: [{ order: 0, label: 'Target' }] },
      { revision: 'catalog-1', targets: [{ order: 257, label: 'Target' }] },
      { revision: 'catalog-1', targets: [{ order: 1, label: 42 }] },
      { revision: 'catalog-1', targets: [{ order: 1, label: 'a'.repeat(81) }] },
    ]) {
      expect(
        (await agent.fetch(post('/live/agent/select', { ...first, nativeTransferAllowed: true, catalog: invalid })))
          .status,
      ).toBe(400);
      expect(agent.selectedRoute).toBeUndefined();
    }
    expect((await agent.fetch(post('/live/agent/select', { ...first, catalog }))).status).toBe(400);
    expect(
      (await agent.fetch(post('/live/agent/select', { ...first, catalog, nativeTransferAllowed: true }))).status,
    ).toBe(200);
    expect(agent.selectedRoute).toMatchObject(first);
    expect(agent.selectedCatalog).toEqual(catalog);
    expect(agent.nativeTransferAllowed).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(
      (await agent.fetch(post('/live/agent/select', { ...first, catalog, nativeTransferAllowed: true }))).status,
    ).toBe(200);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await agent.fetch(post('/live/agent/prepare', second))).status).toBe(200);
    expect(agent.selectedRoute).toBeUndefined();
    expect((await agent.fetch(post('/live/agent/select', first))).status).toBe(409);
    expect(
      (await agent.fetch(post('/live/agent/select', { ...second, catalog, nativeTransferAllowed: false }))).status,
    ).toBe(200);
    expect(agent.nativeTransferAllowed).toBe(false);
    expect((await agent.fetch(post('/live/agent/revoke', first))).status).toBe(409);
    expect(agent.selectedRoute).toMatchObject(second);
    expect((await agent.fetch(post('/live/agent/revoke', second))).status).toBe(204);
    expect(agent.selectedRoute).toBeUndefined();
    expect(agent.selectedCatalog).toBeUndefined();
    expect(agent.nativeTransferAllowed).toBe(false);
    expect(changed).toHaveBeenCalledTimes(4);
    expect((await agent.fetch(post('/live/agent/select', second))).status).toBe(409);
    agent.close();
  });
});
