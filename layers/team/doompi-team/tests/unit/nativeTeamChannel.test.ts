import { describe, expect, it } from 'vitest';
import type { DoomChildSessionRuntime } from '@agimon-ai/doompi-core/child';
import { NativeTeamChannelService } from '../../src/services/nativeTeamChannel';

interface FakeTool {
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

function makePi() {
  const tools = new Map<string, FakeTool>();
  const sendMessageCalls: Array<{ message: { content: string; details?: Record<string, unknown> } }> = [];
  const pi = {
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    registerTool: (tool: FakeTool & { name: string }) => tools.set(tool.name, tool),
    sendMessage: (message: { content: string; details?: Record<string, unknown> }) =>
      sendMessageCalls.push({ message }),
    sendUserMessage: () => undefined,
    on: () => undefined,
    tools,
    sendMessageCalls,
  };
  return pi;
}

function childRuntime(steer: (message: string) => Promise<void>): DoomChildSessionRuntime {
  return {
    sessionId: 'native-child-session',
    prompt: async () => undefined,
    steer,
    followUp: async () => undefined,
    abort: async () => undefined,
    dispose: async () => undefined,
  };
}

describe('direct in-process native Team channel', () => {
  it('routes members and messages directly between the parent and native child', async () => {
    const service = new NativeTeamChannelService();
    const mainPi = makePi();
    const main = service.createRuntime(mainPi as never);
    const root = main.bindMainSession('direct-routing');
    const received: string[] = [];
    const intercom = service.createNativeChildIntercom({
      rootSessionId: root.rootSessionId,
      agent: 'worker',
      runId: 'run-direct-1',
    });
    const childTool = intercom?.bindRuntime(childRuntime(async (message) => void received.push(message)));

    expect(childTool).toBeDefined();
    const members = await main.execute('members-op', { action: 'members' });
    expect((members.details as { members: Array<{ agent?: string }> }).members).toEqual(
      expect.arrayContaining([expect.objectContaining({ agent: 'worker' })]),
    );

    await main.execute('send-to-child', { action: 'send', to: 'worker', message: 'review this' });
    expect(received).toEqual([expect.stringContaining('review this')]);

    await childTool!.execute('send-to-main', { action: 'send', to: 'main', message: 'done' });
    expect(mainPi.sendMessageCalls).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ content: expect.stringContaining('done') }) }),
    ]);

    intercom?.dispose?.();
    main.dispose();
  });

  it('supports direct ask, pending, and reply without filesystem polling', async () => {
    const service = new NativeTeamChannelService();
    const main = service.createRuntime(makePi() as never);
    const root = main.bindMainSession('direct-ask');
    const intercom = service.createNativeChildIntercom({
      rootSessionId: root.rootSessionId,
      agent: 'worker',
      runId: 'run-direct-ask',
    });
    const childTool = intercom!.bindRuntime(childRuntime(async () => undefined));

    const answer = main.execute('ask-child', { action: 'ask', to: 'worker', message: 'ready?' });
    await Promise.resolve();
    const pending = await childTool.execute('pending-child', { action: 'pending' });
    const requestId = (pending.details as { pending: Array<{ id: string }> }).pending[0]?.id;
    expect(requestId).toBeDefined();
    await childTool.execute('reply-child', { action: 'reply', requestId, message: 'yes' });
    await expect(answer).resolves.toMatchObject({ details: { reply: 'yes' } });

    intercom!.dispose?.();
    main.dispose();
  });

  it('isolates members by root session and releases a disposed root', async () => {
    const service = new NativeTeamChannelService();
    const first = service.createRuntime(makePi() as never);
    const second = service.createRuntime(makePi() as never);
    const firstRoot = first.bindMainSession('direct-first');
    second.bindMainSession('direct-second');
    const child = service.createNativeChildIntercom({
      rootSessionId: firstRoot.rootSessionId,
      agent: 'worker',
      runId: 'run-first',
    });
    child!.bindRuntime(childRuntime(async () => undefined));

    const secondMembers = await second.execute('members-second', { action: 'members' });
    expect((secondMembers.details as { members: Array<{ agent?: string }> }).members).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ agent: 'worker' })]),
    );
    await expect(
      second.execute('send-second', { action: 'send', to: 'worker', message: 'wrong root' }),
    ).rejects.toThrow('not found');

    first.dispose();
    expect(
      service.createNativeChildIntercom({ rootSessionId: firstRoot.rootSessionId, agent: 'late', runId: 'run-late' }),
    ).toBeUndefined();
    second.dispose();
  });
});
