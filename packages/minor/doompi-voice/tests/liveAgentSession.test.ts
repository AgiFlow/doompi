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
});
