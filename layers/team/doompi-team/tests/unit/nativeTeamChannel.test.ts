import type { DoomChildSessionRuntime } from '@agimon-ai/doompi-core/child';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';

import { NativeTeamChannelService } from '../../src/services/nativeTeamChannel';

interface FakeTool {
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

function makePi() {
  const tools = new Map<string, FakeTool>();
  const sendMessageCalls: Array<{
    message: { content: string; customType?: string; details?: Record<string, unknown> };
  }> = [];
  const pi = {
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    registerTool: (tool: FakeTool & { name: string }) => tools.set(tool.name, tool),
    sendMessage: (message: { content: string; customType?: string; details?: Record<string, unknown> }) =>
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

/** The rendered text of a tool result, whose content union also carries image parts. */
function textOf(result: AgentToolResult<Record<string, unknown>>): string {
  return result.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
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
      expect.objectContaining({
        message: expect.objectContaining({
          content: expect.stringContaining('done'),
          customType: 'intercom_message',
          details: expect.objectContaining({
            kind: 'send',
            from: expect.objectContaining({ agent: 'worker' }),
            message: 'done',
          }),
        }),
      }),
    ]);

    intercom?.dispose?.();
    main.dispose();
  });

  // The whole point of a generated identity is that what a peer is shown is
  // what a peer can address. If the member id and the displayed name ever
  // diverge, the model copies the label into `to:` and gets recipient_not_found.
  it('uses the generated identity as the member id and accepts it as an address', async () => {
    const service = new NativeTeamChannelService();
    const mainPi = makePi();
    const main = service.createRuntime(mainPi as never);
    const root = main.bindMainSession('identity-routing');
    const received: string[] = [];
    const intercom = service.createNativeChildIntercom({
      rootSessionId: root.rootSessionId,
      agent: 'doompi-reviewer',
      identity: 'alan-reviewer-1',
      runId: 'run-identity-1',
    });
    intercom?.bindRuntime(childRuntime(async (message) => void received.push(message)));

    const members = await main.execute('members-op', { action: 'members' });
    const listed = (members.details as { members: Array<{ name: string; inline?: boolean }> }).members;
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'alan-reviewer-1' })]));
    expect(textOf(members)).toContain('- alan-reviewer-1: doompi-reviewer');

    await main.execute('send-by-identity', { action: 'send', to: 'alan-reviewer-1', message: 'by identity' });
    expect(received).toEqual([expect.stringContaining('by identity')]);

    intercom?.dispose?.();
    main.dispose();
  });

  it('marks an inline child in the roster, which its agent name cannot say', async () => {
    const service = new NativeTeamChannelService();
    const mainPi = makePi();
    const main = service.createRuntime(mainPi as never);
    const root = main.bindMainSession('identity-inline');
    const received: string[] = [];
    const intercom = service.createNativeChildIntercom({
      rootSessionId: root.rootSessionId,
      agent: 'doompi-developer',
      identity: 'bea-developer-2',
      inline: true,
      runId: 'run-identity-2',
    });
    const childTool = intercom?.bindRuntime(childRuntime(async (message) => void received.push(message)));

    const members = await main.execute('members-op', { action: 'members' });
    expect(textOf(members)).toContain('- bea-developer-2 (inline): doompi-developer');

    // The sender line the recipient reads carries the same marker.
    await childTool!.execute('send-to-main', { action: 'send', to: 'main', message: 'hello' });
    expect(mainPi.sendMessageCalls[0]?.message.content).toContain('bea-developer-2 (inline)');

    intercom?.dispose?.();
    main.dispose();
  });

  it('falls back to the run-id shape when no identity could be claimed', async () => {
    const service = new NativeTeamChannelService();
    const mainPi = makePi();
    const main = service.createRuntime(mainPi as never);
    const root = main.bindMainSession('identity-fallback');
    const intercom = service.createNativeChildIntercom({
      rootSessionId: root.rootSessionId,
      agent: 'worker',
      runId: 'abcdef1234567890',
    });
    intercom?.bindRuntime(childRuntime(async () => undefined));

    const members = await main.execute('members-op', { action: 'members' });
    const listed = (members.details as { members: Array<{ name: string }> }).members;
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'worker-abcdef12' })]));

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
