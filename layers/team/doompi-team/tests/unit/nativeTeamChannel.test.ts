import type { DoomChildSessionRuntime } from '@agimon-ai/doompi-core/childSession';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NativeTeamChannelService,
  parseTeamToolParams,
  TeamToolParamsSchema,
} from '../../src/services/nativeTeamChannel';

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
  describe('async ask', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function setup(name: string, steer?: (message: string) => Promise<void>) {
      const service = new NativeTeamChannelService();
      const mainPi = makePi();
      const main = service.createRuntime(mainPi as never);
      const root = main.bindMainSession(name);
      const received: string[] = [];
      const intercom = service.createNativeChildIntercom({
        rootSessionId: root.rootSessionId,
        agent: 'worker',
        runId: `run-${name}`,
      })!;
      const childTool = intercom.bindRuntime(childRuntime(steer ?? (async (message) => void received.push(message))));
      const lastToMain = () => mainPi.sendMessageCalls.at(-1)?.message;
      return { main, mainPi, received, intercom, childTool, lastToMain };
    }

    it('returns at once and delivers the reply to the asker as a message, both directions', async () => {
      const { main, received, intercom, childTool, lastToMain } = setup('ask-both-ways');

      const asked = await main.execute('ask-child', { action: 'ask', to: 'worker', message: 'ready?' });
      const requestId = (asked.details as { requestId: string }).requestId;
      expect(asked.details).toMatchObject({ delivered: true, requestId: expect.any(String) });
      expect(received).toEqual([expect.stringContaining('ready?')]);
      await childTool.execute('reply-child', { action: 'reply', requestId, message: 'yes' });
      expect(lastToMain()).toMatchObject({
        content: expect.stringContaining(`Reply from worker-run-ask- [worker] to your question ${requestId}`),
        details: { kind: 'reply', message: 'yes', requestId },
      });
      await expect(childTool.execute('reply-again', { action: 'reply', requestId, message: 'yes' })).rejects.toThrow(
        'No open intercom ask',
      );

      const childAsk = await childTool.execute('ask-main', { action: 'ask', to: 'main', message: 'which db?' });
      const childRequestId = (childAsk.details as { requestId: string }).requestId;
      expect(lastToMain()).toMatchObject({ details: { kind: 'ask', message: 'which db?' } });
      await main.execute('reply-main', { action: 'reply', requestId: childRequestId, message: 'postgres' });
      expect(received.at(-1)).toContain(`Reply from main to your question ${childRequestId}.\n\npostgres`);

      // A retried tool call returns the first outcome without asking twice.
      const before = received.length;
      await main.execute('ask-child-retry', { action: 'ask', to: 'worker', message: 'again?' });
      await main.execute('ask-child-retry', { action: 'ask', to: 'worker', message: 'again?' });
      expect(received).toHaveLength(before + 1);

      intercom.dispose?.();
      main.dispose();
    });

    it('reminds the asker once after 3 minutes, keeps the ask open, and lets the child decide', async () => {
      vi.useFakeTimers();
      const { main, received, intercom, childTool, lastToMain } = setup('ask-reminder');
      const asked = await childTool.execute('ask-main', { action: 'ask', to: 'main', message: 'which db?' });
      const requestId = (asked.details as { requestId: string }).requestId;
      expect(lastToMain()?.details).toMatchObject({ kind: 'ask' });

      let held: boolean | undefined;
      void intercom.hold!().then((more) => (held = more));
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 - 1);
      expect(held).toBeUndefined();
      expect(received).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(held).toBe(true);
      expect(received).toEqual([expect.stringContaining(`No reply from main to your question ${requestId}.`)]);
      expect(received[0]).toContain('It is your call: keep working, ask again, or finish.');

      // The ask stays open: still pending for main, and a late reply still lands.
      const pending = await main.execute('pending-main', { action: 'pending' });
      expect(pending.details).toEqual({ pending: [{ id: requestId, from: 'worker-run-ask-' }] });
      await main.execute('late-reply', { action: 'reply', requestId, message: 'postgres' });
      expect(received.at(-1)).toContain('postgres');
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      expect(received).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);

      // Nothing left to wait for once the deliveries are drained: the run may finish.
      await expect(intercom.hold!()).resolves.toBe(true);
      await expect(intercom.hold!()).resolves.toBe(false);
      await expect(main.execute('send-gone', { action: 'send', to: 'worker', message: 'hi' })).rejects.toThrow(
        'not found',
      );

      main.dispose();
    });

    it('holds a child open while its question is unanswered and releases it on the reply', async () => {
      const { main, intercom, childTool } = setup('ask-hold');
      const asked = await childTool.execute('ask-main', { action: 'ask', to: 'main', message: 'which db?' });
      const requestId = (asked.details as { requestId: string }).requestId;

      let held: boolean | undefined;
      const parked = intercom.hold!().then((more) => (held = more));
      await Promise.resolve();
      expect(held).toBeUndefined();
      await main.execute('reply-main', { action: 'reply', requestId, message: 'postgres' });
      await parked;
      expect(held).toBe(true);

      await expect(intercom.hold!()).resolves.toBe(true);
      await expect(intercom.hold!()).resolves.toBe(false);
      const members = await main.execute('members-op', { action: 'members' });
      expect((members.details as { members: Array<{ agent?: string }> }).members).toEqual([
        expect.objectContaining({ name: 'main' }),
      ]);
      main.dispose();
    });

    it('tells the asker at once when the asked member finishes without replying', async () => {
      vi.useFakeTimers();
      const { main, intercom, lastToMain } = setup('ask-target-gone');
      const asked = await main.execute('ask-child', { action: 'ask', to: 'worker', message: 'ready?' });
      const requestId = (asked.details as { requestId: string }).requestId;

      intercom.dispose?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(lastToMain()).toMatchObject({
        content: expect.stringContaining(`No reply from worker-run-ask- [worker] to your question ${requestId}.`),
        details: { kind: 'no_reply', requestId },
      });
      expect(lastToMain()?.content).toContain('It finished without replying.');
      expect(vi.getTimerCount()).toBe(0);
      main.dispose();
    });

    it('surfaces a failed hand-off and leaves no ask behind', async () => {
      const { main, intercom, childTool } = setup('ask-fails', async () => {
        throw new Error('lane closed');
      });
      await expect(main.execute('send-child', { action: 'send', to: 'worker', message: 'hi' })).rejects.toMatchObject({
        code: 'communication_unavailable',
        message: expect.stringContaining('lane closed'),
      });
      await expect(main.execute('ask-child', { action: 'ask', to: 'worker', message: 'ready?' })).rejects.toMatchObject(
        {
          code: 'communication_unavailable',
        },
      );
      const pending = await childTool.execute('pending-child', { action: 'pending' });
      expect(pending.details).toEqual({ pending: [] });
      intercom.dispose?.();
      main.dispose();
    });

    it('releases a parked hold with false when the channel is disposed', async () => {
      const { main, childTool, intercom } = setup('ask-dispose');
      await childTool.execute('ask-main', { action: 'ask', to: 'main', message: 'which db?' });
      const parked = intercom.hold!();
      main.dispose();
      await expect(parked).resolves.toBe(false);
    });
  });

  it('declares a flat schema the model can see and still validates each action', () => {
    const schema = TeamToolParamsSchema as unknown as { type: string; properties: object; oneOf?: unknown };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(['action', 'to', 'message', 'requestId']);
    expect(schema.oneOf).toBeUndefined();
    expect(() => parseTeamToolParams({ action: 'send', message: 'hi' })).toThrow('requires to');
    expect(() => parseTeamToolParams({ action: 'ask', to: ' ', message: 'hi' })).toThrow('requires to');
    expect(() => parseTeamToolParams({ action: 'reply', message: 'hi' })).toThrow('requires requestId');
    expect(() => parseTeamToolParams({ action: 'ask', to: 'main', message: 'hi', timeoutMs: 5 })).toThrow(
      'does not accept: timeoutMs',
    );
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
