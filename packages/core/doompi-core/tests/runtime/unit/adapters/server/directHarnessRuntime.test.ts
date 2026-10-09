import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createAssistantMessageEventStream,
  type Api,
  type Model,
  type Models,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import { streamSimple as codexStreamSimple } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { parseServerMessage } from '@earendil-works/pi-protocol';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import { DoomHeadlessToolBusyError } from '../../../../../src/schemas/headless';
import { createDirectHarnessRuntime, promptForAssistantText } from '../../../../../src/server/directHarnessRuntime';
import { createHistoryOwnership, historyOwnershipLockPath } from '../../../../../src/services/historyOwnership';
import type { HarnessEvent } from '../../../../../src/types/server/directHarnessRuntime';
import type { DirectHarnessRuntimeOptions } from '../../../../../src/types/server/directHarnessRuntime';

const model: Model<Api> = {
  id: 'test',
  name: 'Test',
  api: 'test',
  provider: 'fixture',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 256,
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function response(content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse' = 'stop') {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage,
    stopReason,
  };
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: stopReason, message });
  stream.end();
  return stream;
}
async function setup(
  options: Partial<DirectHarnessRuntimeOptions> = {},
  answers: ReturnType<typeof response>[] = [response([{ type: 'text', text: 'answer' }])],
) {
  const streamSimple = vi.fn<Models['streamSimple']>(() => {
    const answer = answers.shift();
    if (!answer) throw new Error('Unexpected model request');
    return answer;
  });
  const models = {
    getModels: () => [model],
    getAvailable: async () => [model],
    getModel: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
    streamSimple,
    complete: vi.fn(),
  } as unknown as Models;
  const storage = new MemoryStorage();
  const runtime = await createDirectHarnessRuntime({
    cwd: '/tmp',
    durableStorage: storage,
    models,
    model,
    compaction: { enabled: false },
    ...options,
  });
  return { runtime, streamSimple, storage, models };
}
describe('durable direct runtime', () => {
  it('keeps persisted request identity across successive and resumed turns, distinct from children', async () => {
    const storage = new MemoryStorage();
    const close = vi.spyOn(storage, 'close').mockResolvedValue(undefined);
    const first = await setup({ durableStorage: storage, sessionId: 'owner' }, [response([]), response([])]);
    try {
      await first.runtime.prompt('one');
      await first.runtime.prompt('two');
      expect(first.streamSimple.mock.calls.map((call) => call[2]?.sessionId)).toEqual(['owner', 'owner']);
    } finally {
      await first.runtime.dispose();
    }
    const resumed = await setup({ durableStorage: storage, sessionId: 'ignored' });
    const child = await setup({ parentSessionId: 'owner' });
    try {
      await resumed.runtime.prompt('resume');
      await child.runtime.prompt('child');
      expect(resumed.streamSimple.mock.calls[0]![2]?.sessionId).toBe('owner');
      expect(child.streamSimple.mock.calls[0]![2]?.sessionId).toEqual(expect.any(String));
      expect(child.streamSimple.mock.calls[0]![2]?.sessionId).not.toBe('owner');
    } finally {
      await resumed.runtime.dispose();
      await child.runtime.dispose();
      close.mockRestore();
      await storage.close(BACKGROUND_CONTEXT);
    }
  });
  it('preserves auxiliary request overrides, retention and payload chaining', async () => {
    const beforePayload = vi.fn(({ payload }: { payload: unknown }) => ({ payload }));
    const { runtime, models } = await setup({ sessionId: 'owner', beforePayload });
    const onPayload = vi.fn(() => ({ changed: true }));
    try {
      await runtime.completeModel!(
        model,
        { messages: [] },
        {
          sessionId: 'auxiliary',
          cacheRetention: 'none',
          temperature: 0.25,
          onPayload,
        },
      );
      const complete = vi.mocked(models.complete);
      const options = complete.mock.calls[0]![2]!;
      expect(options).toMatchObject({ sessionId: 'auxiliary', cacheRetention: 'none', temperature: 0.25 });
      expect(await options.onPayload!({ original: true }, model)).toEqual({ changed: true });
      expect(onPayload).toHaveBeenCalledOnce();
      expect(beforePayload).toHaveBeenCalledWith({ payload: { changed: true }, model }, BACKGROUND_CONTEXT);
    } finally {
      await runtime.dispose();
    }
  });
  it.each(['same', 'copy', 'prompt', 'messages'] as const)(
    'preserves positional messages only for unchanged %s patches',
    async (kind) => {
      let native: unknown[] = [];
      const { runtime, streamSimple } = await setup({
        systemPrompt: 'original',
        beforeModelRequest: (event) => {
          if (event.phase === 'turn') native = structuredClone(event.prompt ?? []);
        },
        transformContext: ({ messages, systemPrompt }) => ({
          messages: kind === 'copy' ? structuredClone(messages) : kind === 'messages' ? [] : messages,
          systemPrompt: kind === 'prompt' ? 'changed' : systemPrompt,
        }),
      });
      try {
        await runtime.prompt('question');
        const actual = streamSimple.mock.calls[0]![1].messages;
        if (kind === 'same' || kind === 'copy') expect(actual).toEqual(native);
        else if (kind === 'prompt') expect(actual[0]).toMatchObject({ role: 'system', content: 'changed' });
        else expect(actual.filter((message) => message.role !== 'system')).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    },
  );
  it('forwards aggregate block snapshots to frames and event listeners', async () => {
    const stream = createAssistantMessageEventStream();
    const initial: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'initial' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      usage,
      stopReason: 'stop',
    };
    const { runtime } = await setup({}, [stream]);
    const events: HarnessEvent[] = [];
    const frames: Record<string, unknown>[] = [];
    runtime.onEvent((event) => {
      events.push(event);
    });
    runtime.onPresentationFrame((frame) => frames.push(frame));
    try {
      const active = await runtime.submitPrompt('stream');
      stream.push({ type: 'start', partial: initial });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === 'message_start' && event.message.role === 'assistant')).toBe(true),
      );
      const partial = { ...initial, content: [{ type: 'text' as const, text: 'whole block' }] };
      stream.push({ type: 'text_start', contentIndex: 0, partial });
      await vi.waitFor(() =>
        expect(
          events.some(
            (event) =>
              event.type === 'message_update' &&
              event.message.content.some((block) => block.type === 'text' && block.text === 'whole block'),
          ),
        ).toBe(true),
      );
      expect(frames.some((frame) => frame.type === 'message_update')).toBe(true);
      const aggregate: AssistantMessage = {
        ...partial,
        content: [
          { type: 'text', text: 'whole message' },
          { type: 'thinking', thinking: 'reasoning snapshot' },
          { type: 'toolCall', id: 'snapshot-call', name: 'fixture', arguments: { value: 'snapshot' } },
        ],
      };
      stream.push({ type: 'toolcall_start', contentIndex: 2, partial: aggregate });
      await vi.waitFor(() =>
        expect(
          events.some(
            (event) =>
              event.type === 'message_update' &&
              JSON.stringify(event.message.content) === JSON.stringify(aggregate.content),
          ),
        ).toBe(true),
      );
      expect(
        frames.some(
          (frame) =>
            frame.type === 'message_update' &&
            JSON.stringify((frame.message as AssistantMessage).content) === JSON.stringify(aggregate.content),
        ),
      ).toBe(true);
      stream.push({ type: 'done', reason: 'stop', message: partial });
      await active.settled;
    } finally {
      await runtime.dispose();
    }
  });
  it('forwards committed model entries and usage before turn end with ancestry', async () => {
    const { runtime } = await setup(
      {
        tools: [
          { name: 'fixture', description: 'test', parameters: Type.Object({}), execute: async () => ({ content: [] }) },
        ],
      },
      [
        response([{ type: 'toolCall', id: 'call', name: 'fixture', arguments: {} }], 'toolUse'),
        response([{ type: 'text', text: 'first' }]),
        response([{ type: 'text', text: 'second' }]),
      ],
    );
    const events: HarnessEvent[] = [];
    runtime.onEvent((event) => {
      events.push(event);
    });
    try {
      await runtime.prompt('question');
      await runtime.prompt('another question');
      const entries = (await runtime.readEntries()).entries;
      const added = events.filter((event) => event.type === 'entry_added');
      for (const entry of entries.filter((entry) => entry.type === 'message')) {
        const matching = added.filter((event) => event.entry.id === entry.id);
        expect(matching).toHaveLength(1);
        expect(matching[0]?.entry).toEqual(entry);
      }
      expect(events.filter((event) => event.type === 'usage')).toHaveLength(3);
      const turns = events.filter((event) => event.type === 'turn_end');
      expect(turns).toHaveLength(3);
      expect(turns[0]?.toolResults).toHaveLength(1);
      for (const turn of turns) {
        const preceding = events.slice(0, events.indexOf(turn)).filter((event) => event.type === 'entry_added');
        expect(
          preceding.findLast((event) => event.entry.type === 'message' && event.entry.message.role === 'assistant')
            ?.entry,
        ).toMatchObject({ message: turn.message });
        for (const result of turn.toolResults) {
          expect(
            preceding.findLast((event) => event.entry.type === 'message' && event.entry.message.role === 'toolResult')
              ?.entry,
          ).toMatchObject({ message: result });
        }
      }
    } finally {
      await runtime.dispose();
    }
  });
  it('retains writer closure failure across idempotent disposal', async () => {
    const { runtime } = await setup();
    const failure = new Error('writer closure failed');
    vi.spyOn(runtime.harness, 'close').mockRejectedValue(failure);
    // An unconfirmed writer closure must remain a failed, idempotent disposal.
    await expect(runtime.dispose()).rejects.toMatchObject({ errors: [failure] });
    await expect(runtime.exited).resolves.toBe(1);
    await expect(runtime.dispose()).rejects.toMatchObject({ errors: [failure] });
  });
  it('holds a prompt open across turns that intercom delivery starts on an idle lane', async () => {
    const { runtime, streamSimple } = await setup({}, [
      response([{ type: 'text', text: 'first' }]),
      response([{ type: 'text', text: 'second' }]),
    ]);
    const hold = vi.fn(async () => {
      if (hold.mock.calls.length > 1) return false;
      // Admission only, like intercom steer: the turn it starts must be drained by the caller.
      await runtime.submitInternalMessage('reply arrived', 'steer');
      return true;
    });
    try {
      expect(await promptForAssistantText(runtime, 'question', hold)).toBe('second');
      expect(hold).toHaveBeenCalledTimes(2);
      expect(streamSimple).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
    }
  });
  it('submits through durable Harness and projects string protocol IDs', async () => {
    const { runtime, streamSimple } = await setup();
    try {
      expect(await promptForAssistantText(runtime, 'question')).toBe('answer');
      const entries = (await runtime.readEntries()).entries;
      expect(entries.filter((e) => e.type === 'message').map((e) => e.message.role)).toEqual([
        'user',
        'system',
        'assistant',
      ]);
      expect(entries.every((e) => typeof e.id === 'string')).toBe(true);
      expect(streamSimple).toHaveBeenCalledOnce();
      expect((await runtime.readState()).isStreaming).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
  it('publishes a rename immediately after committing it', async () => {
    const { runtime } = await setup({ sessionName: 'worktree/child' });
    try {
      const frames: unknown[] = [];
      runtime.onPresentationFrame((frame) => frames.push(frame));
      await runtime.setName('Renamed child');
      expect(await runtime.readState()).toMatchObject({ sessionName: 'Renamed child' });
      expect(frames).toContainEqual({ type: 'session_info_changed', name: 'Renamed child' });
    } finally {
      await runtime.dispose();
    }
  });
  it('retains a rename when reopened with the nested worktree creation name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runtime-rename-'));
    const options = {
      sessionsRoot: root,
      durableStorage: undefined,
      historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
      sessionId: 'nested-worktree',
      parentSessionId: 'parent-worktree',
      sessionName: 'worktree/child',
      cwd: path.join(root, 'parent', 'child'),
    };
    let { runtime } = await setup(options);
    try {
      await runtime.setName('Renamed child');
      expect(await runtime.readState()).toMatchObject({ sessionName: 'Renamed child' });
      await runtime.dispose();
      ({ runtime } = await setup(options));
      expect(await runtime.readState()).toMatchObject({ sessionName: 'Renamed child' });
      await runtime.setName('');
      await runtime.dispose();
      ({ runtime } = await setup(options));
      expect(await runtime.readState()).toMatchObject({ sessionName: '' });
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('returns wire-safe state before the first prompt and after settling', async () => {
    const { runtime } = await setup();
    try {
      const initial = await runtime.readState();
      expect(initial).toMatchObject({ model: { provider: model.provider, id: model.id }, fastMode: false });
      expect(() => parseServerMessage({ type: 'response', id: 'initial', ok: true, result: initial })).not.toThrow();
      await runtime.setName('wire-safe');
      await promptForAssistantText(runtime, 'question');
      const settled = await runtime.readState();
      expect(settled).toMatchObject({ sessionName: 'wire-safe', isStreaming: false, pendingMessageCount: 0 });
      expect(() => parseServerMessage({ type: 'response', id: 'settled', ok: true, result: settled })).not.toThrow();
    } finally {
      await runtime.dispose();
    }
  });
  it('reports latest context occupancy with durable stats, without counting output or older turns', async () => {
    const { runtime } = await setup();
    try {
      expect(await runtime.getSessionStats()).toMatchObject({
        contextUsage: { tokens: null, contextWindow: model.contextWindow, percent: null },
      });
      for (const input of [50_000, 100]) {
        await runtime.appendMessage({
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: 'stop',
          usage: { ...usage, input, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: input + 60 },
        });
      }
      expect(await runtime.getSessionStats()).toMatchObject({
        contextUsage: { tokens: 140, contextWindow: model.contextWindow, percent: 0 },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it.each(['failed', 'faulted', 'declined'] as const)(
    'does not report an older compaction as completed when the next compaction is %s',
    async (outcome) => {
      let first = true;
      const { runtime, models } = await setup({
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        beforeCompaction: () => {
          if (first) return { compaction: { summary: 'older summary', tokensBefore: 10, retainedTail: [] } };
          if (outcome === 'declined') return { decline: true };
          return undefined;
        },
      });
      const completeSimple = vi.fn<Models['completeSimple']>(async () => {
        if (outcome === 'faulted') throw new Error('summary provider fault');
        return {
          ...(await response([]).result()),
          stopReason: 'error',
          errorMessage: 'summary provider failed',
        };
      });
      Object.assign(models, { completeSimple });
      const events: HarnessEvent[] = [];
      runtime.onEvent((event) => {
        events.push(event);
      });
      try {
        await runtime.appendMessage({ role: 'user', content: 'old context', timestamp: 1 });
        await runtime.appendMessage({ role: 'user', content: 'retained context', timestamp: 2 });
        await runtime.compact();
        const older = (await runtime.readEntries()).entries.findLast((entry) => entry.type === 'compaction');
        expect(older).toBeDefined();
        await vi.waitFor(() => expect(events.filter((event) => event.type === 'compaction_end')).toHaveLength(1));
        expect(events.find((event) => event.type === 'compaction_end')).toMatchObject({
          status: 'completed',
          entryId: older!.id,
        });
        first = false;
        await runtime.appendMessage({ role: 'user', content: 'new context', timestamp: 3 });
        if (outcome === 'declined') await runtime.compact();
        else await expect(runtime.compact()).rejects.toThrow('Compaction failed');
        await vi.waitFor(() => expect(events.filter((event) => event.type === 'compaction_end')).toHaveLength(2));
        const ends = events.filter((event) => event.type === 'compaction_end');
        expect((await runtime.readEntries()).entries.filter((entry) => entry.type === 'compaction')).toEqual([older]);
        expect.soft(ends[1]).toMatchObject({ status: outcome === 'declined' ? 'aborted' : 'failed', reason: 'manual' });
        expect.soft(ends[1]?.entryId).toBeUndefined();
        expect.soft(ends[0]?.error).toBeUndefined();
        if (outcome === 'declined') {
          expect(ends[1]?.error).toBeUndefined();
          expect(completeSimple).not.toHaveBeenCalled();
        } else {
          expect(ends[1]?.error).toBeInstanceOf(Error);
          expect(completeSimple).toHaveBeenCalledOnce();
        }
      } finally {
        await runtime.dispose();
      }
    },
  );

  it('reports empty compaction as aborted without an entry or error', async () => {
    const { runtime } = await setup();
    const events: HarnessEvent[] = [];
    runtime.onEvent((event) => {
      events.push(event);
    });
    try {
      await runtime.compact();
      await vi.waitFor(() => expect(events.filter((event) => event.type === 'compaction_end')).toHaveLength(1));
      const ends = events.filter((event) => event.type === 'compaction_end');
      expect(ends[0]).toMatchObject({ status: 'aborted', reason: 'manual' });
      expect(ends[0]?.entryId).toBeUndefined();
      expect(ends[0]?.error).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  it('passive writes publish assistant usage without waking the model', async () => {
    const { runtime, streamSimple } = await setup();
    const events: HarnessEvent[] = [];
    runtime.onEvent((event) => {
      events.push(event);
    });
    try {
      await runtime.appendCustomEntry('fixture', { a: 1 });
      await runtime.appendMessage({ role: 'user', content: 'passive', timestamp: Date.now() });
      await runtime.appendMessage(await response([{ type: 'text', text: 'passive assistant' }]).result());
      expect(events.filter((event) => event.type === 'usage')).toEqual([
        { type: 'usage', row: { id: expect.any(String), usage } },
      ]);
      expect(streamSimple).not.toHaveBeenCalled();
      expect((await runtime.readEntries()).entries.some((e) => e.type === 'custom' && e.customType === 'fixture')).toBe(
        true,
      );
    } finally {
      await runtime.dispose();
    }
  });
  it('registered commands do not admit model work', async () => {
    const dispatchCommand = vi.fn(async (text: string) => text === '/fixture');
    const { runtime, streamSimple } = await setup({ dispatchCommand });
    try {
      const result = await runtime.submitPrompt('/fixture');
      await result.settled;
      expect(result.handledCommand).toBe(true);
      expect((await runtime.submitUserPrompt('/fixture')).handledCommand).toBe(true);
      await runtime.steer('/fixture');
      expect(dispatchCommand).toHaveBeenCalledTimes(3);
      await expect(runtime.steer('')).rejects.toThrow('User input must contain text or an image');
      expect((await runtime.readLifecycle()).queue).toEqual([]);
      expect(streamSimple).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
  it.each(['context', 'turn', 'request', 'system'] as const)(
    'fails closed when %s preparation throws despite durable hooks swallowing errors',
    async (phase) => {
      let blocked = true;
      const fail = () => {
        if (blocked) throw new Error('denied');
      };
      const { runtime, streamSimple } = await setup({
        transformContext:
          phase === 'context'
            ? () => {
                fail();
                return undefined;
              }
            : undefined,
        beforeModelRequest:
          phase === 'turn' || phase === 'request'
            ? (event) => {
                if (event.phase === phase) fail();
              }
            : undefined,
        systemPrompt:
          phase === 'system'
            ? () => {
                fail();
                return 'safe';
              }
            : undefined,
      });
      try {
        await expect(runtime.prompt('blocked')).rejects.toThrow();
        expect(streamSimple).not.toHaveBeenCalled();
        blocked = false;
        await runtime.prompt('allowed');
        expect(streamSimple).toHaveBeenCalledOnce();
      } finally {
        await runtime.dispose();
      }
    },
  );
  it.each(['idle', 'busy'] as const)(
    'preserves checkpoint metadata for %s context projection before provider conversion',
    async (state) => {
      const pending = createAssistantMessageEventStream();
      const details = { requestId: 'checkpoint', retainedMessages: [] };
      const checkpoint = {
        role: 'custom' as const,
        customType: 'fixture.checkpoint',
        content: 'CHECKPOINT_SUMMARY',
        display: false,
        details,
        timestamp: 123,
      };
      let projected = false;
      const { runtime, streamSimple } = await setup(
        {
          transformContext: ({ messages }) => {
            const index = messages.findIndex(
              (message) => message.role === 'custom' && message.customType === checkpoint.customType,
            );
            if (index === -1) return { messages };
            expect(messages[index]).toEqual(checkpoint);
            projected = true;
            return {
              messages: [
                {
                  role: 'compactionSummary',
                  summary: checkpoint.content,
                  tokensBefore: 1000,
                  timestamp: checkpoint.timestamp,
                },
                ...messages.slice(index + 1),
              ],
            };
          },
        },
        state === 'busy' ? [pending, response([{ type: 'text', text: 'compacted answer' }])] : undefined,
      );
      try {
        if (state === 'busy') {
          await runtime.submitPrompt('OLD_CONTEXT');
          await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledOnce());
          const resumed = await runtime.submitInternalMessage(checkpoint);
          pending.push({
            type: 'done',
            reason: 'stop',
            message: await response([{ type: 'text', text: 'old answer' }]).result(),
          });
          await resumed.settled;
        } else {
          await runtime.appendMessage({ role: 'user', content: 'OLD_CONTEXT', timestamp: 1 });
          await runtime.appendMessage(checkpoint);
          await (
            await runtime.submitInternalMessage('resume')
          ).settled;
        }
        expect(projected).toBe(true);
        const input = JSON.stringify(streamSimple.mock.calls.at(-1)![1]);
        expect(input).not.toContain('OLD_CONTEXT');
        expect(input.split('CHECKPOINT_SUMMARY')).toHaveLength(2);
        expect(input).not.toContain('compactionSummary');
        expect((await runtime.readLifecycle()).queue).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    },
  );
  it.each(['omit', 'replace'] as const)(
    'does not restore custom metadata over a native %s context edit',
    async (action) => {
      const transformContext = vi.fn<NonNullable<DirectHarnessRuntimeOptions['transformContext']>>(({ messages }) => ({
        messages,
      }));
      const { runtime, streamSimple } = await setup({ transformContext });
      try {
        await runtime.appendMessage({
          role: 'custom',
          customType: 'fixture.checkpoint',
          content: 'original marker',
          display: false,
          timestamp: 123,
        });
        const target = (await runtime.lane.context(BACKGROUND_CONTEXT)).entries.find(
          (entry) => entry.kind === 'doompi.entry',
        )!.id;
        const edit =
          action === 'omit'
            ? { target, action }
            : { target, action, messages: [{ role: 'user' as const, content: 'edited marker', timestamp: 123 }] };
        await (
          await runtime.lane.submit(
            { type: 'write', entry: { kind: 'fixture.edit', edits: [edit] } },
            BACKGROUND_CONTEXT,
          )
        ).wait(BACKGROUND_CONTEXT);
        await runtime.prompt('resume');
        expect(
          transformContext.mock.calls[0]![0].messages.some((message: { role: string }) => message.role === 'custom'),
        ).toBe(false);
        const input = JSON.stringify(streamSimple.mock.calls[0]![1]);
        expect(input).not.toContain('original marker');
        if (action === 'replace') expect(input).toContain('edited marker');
      } finally {
        await runtime.dispose();
      }
    },
  );
  it('preserves occurrence-specific custom metadata when native contributions are identical', async () => {
    const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'same' }], timestamp: 123 };
    const first = {
      role: 'custom' as const,
      content: 'same',
      customType: 'first',
      details: { id: 1 },
      display: false,
      timestamp: 123,
    };
    const second = { ...first, customType: 'second', details: { id: 2 } };
    const transformContext = vi.fn<NonNullable<DirectHarnessRuntimeOptions['transformContext']>>(({ messages }) => ({
      messages,
    }));
    const { runtime } = await setup({ transformContext });
    try {
      for (const message of [user, first, second]) await runtime.appendMessage(message);
      await runtime.prompt('resume');
      expect(transformContext.mock.calls[0]![0].messages.slice(0, 3)).toEqual([user, first, second]);
    } finally {
      await runtime.dispose();
    }
  });
  it('recovers internal custom metadata from durable receipts after reopening', async () => {
    const message = {
      role: 'custom' as const,
      customType: 'fixture.checkpoint',
      content: 'checkpoint',
      details: { requestId: 'persisted' },
      display: false,
      timestamp: 123,
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runtime-context-'));
    const transformContext = vi.fn<NonNullable<DirectHarnessRuntimeOptions['transformContext']>>(({ messages }) => ({
      messages,
    }));
    const open = () =>
      setup({
        cwd: root,
        sessionsRoot: root,
        sessionId: 'context',
        durableStorage: undefined,
        historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
        transformContext,
      });
    let { runtime } = await open();
    try {
      await (
        await runtime.submitInternalMessage(message)
      ).settled;
      await runtime.dispose();
      ({ runtime } = await open());
      await runtime.prompt('resume');
      expect(transformContext.mock.calls.at(-1)![0].messages).toContainEqual(message);
      expect((await runtime.readLifecycle()).queue).toEqual([]);
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('revalidates model admission before calling provider', async () => {
    const { runtime, streamSimple } = await setup({
      guardModelRequest: () => {
        throw new Error('capability unavailable');
      },
    });
    try {
      await expect(runtime.prompt('blocked')).rejects.toThrow();
      expect(streamSimple).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
  it('executes hooks and tools through durable task APIs', async () => {
    const execute = vi.fn(async (_id: string, _params: unknown) => ({
      content: [{ type: 'text' as const, text: 'tool result' }],
    }));
    const beforeTool = vi.fn(async () => ({ args: { value: 'patched' } }));
    const afterTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'hook result' }] }));
    const { runtime } = await setup(
      {
        tools: [{ name: 'fixture', description: 'test', parameters: Type.Object({ value: Type.String() }), execute }],
        beforeTool,
        afterTool,
      },
      [
        response([{ type: 'toolCall', id: 'call', name: 'fixture', arguments: { value: 'original' } }], 'toolUse'),
        response([{ type: 'text', text: 'done' }]),
      ],
    );
    try {
      await runtime.prompt('test');
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[1]).toEqual({ value: 'patched' });
      expect(beforeTool).toHaveBeenCalledOnce();
      expect(afterTool).toHaveBeenCalledOnce();
      expect(JSON.stringify((await runtime.readEntries()).entries)).toContain('hook result');
    } finally {
      await runtime.dispose();
    }
  });
  it.each(['thrown', 'returned'] as const)('continues after a %s recoverable tool failure', async (kind) => {
    const execute = vi.fn(async () => {
      if (kind === 'thrown') throw new Error('NOT_FOUND: missing resource');
      return { content: [{ type: 'text' as const, text: 'NOT_FOUND: missing resource' }], isError: true };
    });
    const { runtime, streamSimple } = await setup(
      { tools: [{ name: 'fixture', description: 'test', parameters: Type.Object({}), execute }] },
      [
        response([{ type: 'toolCall', id: 'failed-call', name: 'fixture', arguments: {} }], 'toolUse'),
        response([{ type: 'text', text: 'Finished after the expected failure' }]),
      ],
    );
    try {
      await runtime.prompt('test');
      expect(execute).toHaveBeenCalledOnce();
      expect(streamSimple).toHaveBeenCalledTimes(2);
      const entries = (await runtime.readEntries()).entries;
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({ role: 'toolResult', toolCallId: 'failed-call', isError: true }),
        }),
      );
      expect(JSON.stringify(entries)).toContain('NOT_FOUND');
      expect(JSON.stringify(entries)).toContain('Finished after the expected failure');
      expect((await runtime.readLifecycle()).operation).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });
  it('denied tools never execute', async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const { runtime } = await setup(
      {
        tools: [{ name: 'fixture', description: 'test', parameters: Type.Object({}), execute }],
        beforeTool: () => ({ block: { reason: 'security denial' } }),
      },
      [
        response([{ type: 'toolCall', id: 'call', name: 'fixture', arguments: {} }], 'toolUse'),
        response([{ type: 'text', text: 'denied' }]),
      ],
    );
    try {
      await runtime.prompt('test');
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify((await runtime.readEntries()).entries)).toContain('security denial');
    } finally {
      await runtime.dispose();
    }
  });
  it('fork navigation retains the abandoned tail and selected configuration', async () => {
    const { runtime } = await setup({}, [
      response([{ type: 'text', text: 'first' }]),
      response([{ type: 'text', text: 'second' }]),
      response([{ type: 'text', text: 'branch' }]),
    ]);
    try {
      await runtime.prompt('one');
      const target = (await runtime.readEntries()).leafId!;
      await runtime.prompt('two');
      const old = runtime.lane;
      await runtime.navigateTree(target, { summary: 'summary' });
      expect(runtime.lane.id).not.toBe(old.id);
      await runtime.prompt('branch');
      expect(JSON.stringify((await runtime.readEntries()).entries)).not.toContain('second');
      expect(JSON.stringify((await old.context(BACKGROUND_CONTEXT)).messages)).toContain('second');
      expect((await runtime.lane.agent(BACKGROUND_CONTEXT)).model?.modelId).toBe(model.id);
    } finally {
      await runtime.dispose();
    }
  });
  it('empty navigation configures a new conversation before follow-up', async () => {
    const { runtime } = await setup({}, [
      response([{ type: 'text', text: 'first' }]),
      response([{ type: 'text', text: 'fresh' }]),
    ]);
    try {
      await runtime.prompt('one');
      await runtime.navigateTree(null);
      await runtime.prompt('new');
      const entries = (await runtime.readEntries()).entries;
      expect(JSON.stringify(entries)).toContain('fresh');
      expect(JSON.stringify(entries)).not.toContain('first');
      expect((await runtime.lane.agent(BACKGROUND_CONTEXT)).model?.modelId).toBe(model.id);
    } finally {
      await runtime.dispose();
    }
  });
  it('rejects stale or malformed external navigation IDs', async () => {
    const { runtime } = await setup();
    try {
      await expect(runtime.navigateTree('wrong')).rejects.toThrow('Invalid durable identifier');
      await expect(runtime.navigateTree('99999')).rejects.toThrow();
    } finally {
      await runtime.dispose();
    }
  });
  it('automatically starts queued input on an idle agent', async () => {
    const { runtime, streamSimple } = await setup();
    try {
      await runtime.nextRun('queued');
      await vi.waitFor(async () => {
        expect(streamSimple).toHaveBeenCalledOnce();
        expect((await runtime.readLifecycle()).queue).toEqual([]);
        expect((await runtime.readLifecycle()).operation).toBeNull();
      });
      expect(JSON.stringify(streamSimple.mock.calls[0]![1])).toContain('queued');
    } finally {
      await runtime.dispose();
    }
  });
  it('removes pending input without delivering it', async () => {
    const pending = createAssistantMessageEventStream();
    const answer = await response([{ type: 'text', text: 'active answer' }]).result();
    const { runtime, streamSimple } = await setup({}, [pending]);
    const active = await runtime.submitPrompt('active');
    try {
      await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledOnce());
      await runtime.enqueueAutomatic('queued');
      const id = (await runtime.readLifecycle()).queue[0]!.id;
      expect(await runtime.removeQueued(id)).toBe('removed');
      expect(streamSimple).toHaveBeenCalledOnce();
      expect(await runtime.removeQueued(id)).toBe('removed');
    } finally {
      pending.push({ type: 'done', reason: 'stop', message: answer });
      await active.settled.catch(() => undefined);
      await runtime.dispose();
    }
  });
  it('reports durable usage and idempotently disposes', async () => {
    const { runtime } = await setup();
    await runtime.prompt('question');
    const stats = await runtime.getSessionStats();
    expect(stats.usage.totalTokens).toBe(2);
    await runtime.dispose();
    await runtime.dispose();
    expect(await runtime.exited).toBe(0);
  });
  it.each([
    [undefined, 'short'],
    [false, 'short'],
    [true, 'short'],
    [false, 'none'],
  ] as const)(
    'Fast uses real Codex payloads with inherited intent %s and retention %s',
    async (initialFastMode, cacheRetention) => {
      const codexModel = {
        ...model,
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        id: 'gpt-5.4',
      } as Model<'openai-codex-responses'>;
      const payloads: Record<string, unknown>[] = [];
      const headers: Headers[] = [];
      const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64')}.signature`;
      const registry = {
        getModels: () => [codexModel],
        getAvailable: async () => [codexModel],
        getModel: () => codexModel,
        streamSimple: (
          requested: Model<Api>,
          request: Parameters<typeof codexStreamSimple>[1],
          streamOptions: Parameters<Models['streamSimple']>[2],
        ) =>
          codexStreamSimple(requested as Model<'openai-codex-responses'>, request, {
            ...streamOptions,
            apiKey: token,
            transport: 'sse',
            fetch: async (_url, init) => {
              const body = Buffer.from(await new Response(init?.body).arrayBuffer());
              const decoded =
                new Headers(init?.headers).get('content-encoding') === 'gzip'
                  ? gunzipSync(body).toString()
                  : new Headers(init?.headers).get('content-encoding') === 'zstd'
                    ? zstdDecompressSync(body).toString()
                    : body.toString();
              headers.push(new Headers(init?.headers));
              payloads.push(JSON.parse(decoded) as Record<string, unknown>);
              return new Response('fixture capture', { status: 400 });
            },
          }),
      } as unknown as Models;
      const runtime = await createDirectHarnessRuntime({
        cwd: '/tmp',
        durableStorage: new MemoryStorage(),
        models: registry,
        model: codexModel,
        sessionId: 'native-owner',
        streamOptions: { cacheRetention },
        ...(initialFastMode === undefined ? {} : { initialFastMode }),
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: { enabled: false },
        beforePayload: (event) => ({ payload: { ...(event.payload as object), fixture: true } }),
      });
      try {
        expect((await runtime.readState()).fastMode).toBe(initialFastMode ?? false);
        await runtime.prompt('default').catch(() => undefined);
        expect(payloads[0]).toMatchObject({ fixture: true });
        expect(payloads[0]).not.toHaveProperty('api');
        expect(payloads[0]).not.toHaveProperty('sessionId');
        if (cacheRetention === 'none') {
          expect(payloads[0]).not.toHaveProperty('prompt_cache_key');
          expect(headers[0]!.get('session-id')).toBeNull();
        } else {
          expect(payloads[0]).toHaveProperty('prompt_cache_key', 'native-owner');
          expect(headers[0]!.get('session-id')).toBe('native-owner');
        }
        if (initialFastMode) expect(payloads[0]).toHaveProperty('service_tier', 'priority');
        else expect(payloads[0]).not.toHaveProperty('service_tier');
        await runtime.setFastMode(true);
        await runtime.prompt('priority').catch(() => undefined);
        expect(payloads[1]).toMatchObject({ fixture: true, service_tier: 'priority' });
        await runtime.setFastMode(false);
        await runtime.prompt('disabled').catch(() => undefined);
        expect(payloads[2]).not.toHaveProperty('service_tier');
      } finally {
        await runtime.dispose();
      }
    },
  );
  it('rejects Fast enable on non-Codex but always permits disabling', async () => {
    const { runtime } = await setup();
    try {
      await expect(runtime.setFastMode(true)).rejects.toThrow('Codex');
      await runtime.setFastMode(false);
      expect((await runtime.readState()).fastMode).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
  it('retains inherited Fast intent for non-Codex children without changing their payloads', async () => {
    const { runtime, models } = await setup({ initialFastMode: true, sessionId: 'child' });
    const complete = vi.spyOn(models, 'complete').mockImplementation(async (requested, _request, options) => {
      expect(await options?.onPayload?.({ messages: [] }, requested)).toEqual({ messages: [] });
      return response([]).result();
    });
    try {
      expect((await runtime.readState()).fastMode).toBe(true);
      expect((await runtime.readEntries()).entries).toContainEqual(
        expect.objectContaining({
          customType: 'doompi.fast-mode',
          data: { version: 1, enabled: true, sessionId: 'child' },
        }),
      );
      await runtime.completeModel!(model, { messages: [] });
      expect(complete).toHaveBeenCalledOnce();
      await runtime.setFastMode(false);
      expect((await runtime.readState()).fastMode).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects invalid inherited Fast intent before opening storage', async () => {
    await expect(setup({ initialFastMode: 'true' as unknown as boolean })).rejects.toThrow('Initial Fast mode');
  });

  describe('bounded remote admission', () => {
    const waitMs = 30_000;
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }

    it('waits for a native run to settle, preserving immediate nonwaiting busy errors', async () => {
      const pending = createAssistantMessageEventStream();
      const { runtime } = await setup({}, [pending]);
      vi.useFakeTimers();
      const work = vi.fn(async () => 'remote');
      try {
        const active = await runtime.submitPrompt('native');
        await vi.advanceTimersByTimeAsync(0);
        await expect(runtime.runExternalOperation(work)).rejects.toBeInstanceOf(DoomHeadlessToolBusyError);
        await expect(runtime.runExternalOperation(work)).rejects.toThrow('An operation is already running');
        const remote = runtime.runExternalOperation(work, { waitMs });
        await vi.advanceTimersByTimeAsync(100);
        expect(work).not.toHaveBeenCalled();
        pending.push({ type: 'done', reason: 'stop', message: await response([]).result() });
        await active.settled;
        await vi.advanceTimersByTimeAsync(100);
        await expect(remote).resolves.toBe('remote');
        await vi.advanceTimersByTimeAsync(waitMs);
        expect(work).toHaveBeenCalledOnce();
      } finally {
        await runtime.dispose();
        vi.useRealTimers();
      }
    });

    it.each(['timeout', 'pre-abort', 'abort', 'dispose'] as const)(
      '%s stops a busy waiter without executing it later',
      async (kind) => {
        const { runtime } = await setup();
        const hold = deferred<void>();
        const started = deferred<void>();
        const owner = runtime.runExternalOperation(async () => {
          started.resolve();
          await hold.promise;
        });
        await started.promise;
        vi.useFakeTimers();
        const controller = new AbortController();
        const reason = new Error('cancel admission');
        const work = vi.fn(async () => 'must not execute');
        try {
          if (kind === 'pre-abort') controller.abort(reason);
          const remote = runtime.runExternalOperation(work, { signal: controller.signal, waitMs });
          const rejected = expect(remote).rejects;
          const assertion =
            kind === 'timeout'
              ? rejected.toBeInstanceOf(DoomHeadlessToolBusyError)
              : kind === 'dispose'
                ? rejected.toThrow('disposed')
                : rejected.toThrow();
          await vi.advanceTimersByTimeAsync(0);
          if (kind === 'timeout') {
            await vi.advanceTimersByTimeAsync(waitMs - 1);
            expect(work).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
          } else if (kind === 'abort') {
            await vi.advanceTimersByTimeAsync(100);
            controller.abort(reason);
          } else if (kind === 'dispose') {
            const disposal = runtime.dispose();
            hold.resolve();
            await owner;
            await disposal;
            await vi.advanceTimersByTimeAsync(100);
          }
          await assertion;
          hold.resolve();
          await owner;
          await vi.advanceTimersByTimeAsync(waitMs);
          expect(work).not.toHaveBeenCalled();
        } finally {
          hold.resolve();
          await owner;
          await runtime.dispose();
          vi.useRealTimers();
        }
      },
    );

    it.each(['submitPrompt', 'submitUserPrompt'] as const)(
      '%s rejects a remote claim made during command dispatch without retaining the prompt',
      async (method) => {
        const dispatchEntered = deferred<void>();
        const dispatchRelease = deferred<void>();
        const { runtime, streamSimple } = await setup({
          dispatchCommand: async () => {
            dispatchEntered.resolve();
            await dispatchRelease.promise;
            return false;
          },
        });
        const hold = deferred<void>();
        const started = deferred<void>();
        let owner: Promise<void> | undefined;
        try {
          const user = runtime[method]('native');
          await dispatchEntered.promise;
          owner = runtime.runExternalOperation(
            async () => {
              started.resolve();
              await hold.promise;
            },
            { waitMs },
          );
          await started.promise;
          const rejected = expect(user).rejects.toThrow('An operation is already running');
          dispatchRelease.resolve();
          await rejected;
          expect((await runtime.readLifecycle()).queue).toEqual([]);
          expect(streamSimple).not.toHaveBeenCalled();
        } finally {
          dispatchRelease.resolve();
          hold.resolve();
          await owner;
          await runtime.dispose();
        }
      },
    );

    it('waits for user admission to end before claiming the lane', async () => {
      const { runtime } = await setup();
      const hold = deferred<void>();
      const entered = deferred<void>();
      const idle = vi.spyOn(runtime.lane, 'waitForIdle').mockImplementationOnce(async () => {
        entered.resolve();
        await hold.promise;
      });
      vi.useFakeTimers();
      const work = vi.fn(async () => 'remote');
      try {
        const user = runtime.submitUserPrompt('user');
        await entered.promise;
        const remote = runtime.runExternalOperation(work, { waitMs });
        await vi.advanceTimersByTimeAsync(100);
        expect(work).not.toHaveBeenCalled();
        hold.resolve();
        await (
          await user
        ).settled;
        await vi.advanceTimersByTimeAsync(100);
        await expect(remote).resolves.toBe('remote');
        expect(work).toHaveBeenCalledOnce();
      } finally {
        hold.resolve();
        idle.mockRestore();
        await runtime.dispose();
        vi.useRealTimers();
      }
    });

    it('serializes simultaneous remote operations without promising FIFO', async () => {
      const { runtime } = await setup();
      vi.useFakeTimers();
      const hold = deferred<void>();
      let active = 0;
      let maximum = 0;
      const work = vi.fn(async () => {
        maximum = Math.max(maximum, ++active);
        await hold.promise;
        active--;
        return 'done';
      });
      try {
        const first = runtime.runExternalOperation(work, { waitMs });
        const second = runtime.runExternalOperation(work, { waitMs });
        await vi.advanceTimersByTimeAsync(100);
        expect(work).toHaveBeenCalledOnce();
        hold.resolve();
        await vi.advanceTimersByTimeAsync(100);
        await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done']);
        expect(work).toHaveBeenCalledTimes(2);
        expect(maximum).toBe(1);
      } finally {
        hold.resolve();
        await runtime.dispose();
        vi.useRealTimers();
      }
    });

    it('gives pending follow-up work priority over a waiting remote operation', async () => {
      const firstStream = createAssistantMessageEventStream();
      const followStream = createAssistantMessageEventStream();
      const { runtime, streamSimple } = await setup({}, [firstStream, followStream]);
      vi.useFakeTimers();
      const work = vi.fn(async () => 'remote');
      try {
        const active = await runtime.submitPrompt('native');
        await vi.advanceTimersByTimeAsync(0);
        await runtime.followUp('follow-up');
        const remote = runtime.runExternalOperation(work, { waitMs });
        await vi.advanceTimersByTimeAsync(100);
        firstStream.push({ type: 'done', reason: 'stop', message: await response([]).result() });
        await vi.advanceTimersByTimeAsync(100);
        expect(streamSimple).toHaveBeenCalledTimes(2);
        expect(work).not.toHaveBeenCalled();
        followStream.push({ type: 'done', reason: 'stop', message: await response([]).result() });
        await active.settled;
        await vi.advanceTimersByTimeAsync(100);
        await expect(remote).resolves.toBe('remote');
        expect(work).toHaveBeenCalledOnce();
      } finally {
        await runtime.dispose();
        vi.useRealTimers();
      }
    });
  });

  describe('agent lock', () => {
    it('refuses every local turn while locked and still runs remote operations', async () => {
      const { runtime, streamSimple } = await setup({ initialAgentLocked: true });
      try {
        expect(runtime.agentLocked()).toBe(true);
        expect((await runtime.readState()).agentLocked).toBe(true);
        const locked = 'The local agent is locked';
        await expect(runtime.prompt('hi')).rejects.toThrow(locked);
        await expect(runtime.steer('hi')).rejects.toThrow(locked);
        await expect(runtime.followUp('hi')).rejects.toThrow(locked);
        await expect(runtime.nextRun('hi')).rejects.toThrow(locked);
        await expect(runtime.enqueueAutomatic('hi')).rejects.toThrow(locked);
        await expect(runtime.submitUserPrompt('hi')).rejects.toThrow(locked);
        await expect(runtime.runExternalOperation(async () => 'remote')).resolves.toBe('remote');
        expect(streamSimple).not.toHaveBeenCalled();
      } finally {
        await runtime.dispose();
      }
    });

    it('records internal messages while locked without starting a turn', async () => {
      const { runtime, streamSimple } = await setup({ initialAgentLocked: true });
      try {
        await (
          await runtime.submitInternalMessage('runner finished', 'steer')
        ).settled;
        let release!: () => void;
        const external = runtime.runExternalOperation(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
        await vi.waitFor(() => expect(release).toBeDefined());
        await (
          await runtime.submitInternalMessage('during remote call', 'followUp')
        ).settled;
        release();
        await external;
        const text = JSON.stringify((await runtime.readEntries()).entries);
        expect(text).toContain('runner finished');
        expect(text).toContain('during remote call');
        expect(streamSimple).not.toHaveBeenCalled();
        expect((await runtime.readLifecycle()).operation).toBeNull();
      } finally {
        await runtime.dispose();
      }
    });

    it('aborts a running local turn on lock but never a remote operation', async () => {
      let started!: () => void;
      const toolStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const { runtime, streamSimple } = await setup(
        {
          tools: [
            {
              name: 'wait',
              description: 'test',
              parameters: Type.Object({}),
              execute: () =>
                new Promise(() => {
                  started();
                }),
            },
          ],
        },
        [
          response([{ type: 'toolCall', id: 'call', name: 'wait', arguments: {} }], 'toolUse'),
          response([{ type: 'text', text: 'must not run' }]),
        ],
      );
      try {
        const run = runtime.prompt('work');
        await toolStarted;
        await runtime.setAgentLock(true);
        await run;
        expect(streamSimple).toHaveBeenCalledOnce();

        let release!: () => void;
        const external = runtime.runExternalOperation(
          () =>
            new Promise<string>((resolve) => {
              release = () => resolve('remote');
            }),
        );
        await vi.waitFor(() => expect(release).toBeDefined());
        await runtime.setAgentLock(false);
        await runtime.setAgentLock(true);
        release();
        await expect(external).resolves.toBe('remote');
      } finally {
        await runtime.dispose();
      }
    });

    it('persists the lock on reopen and lets a stored unlock win over the creation default', async () => {
      const storage = new MemoryStorage();
      const close = vi.spyOn(storage, 'close').mockResolvedValue(undefined);
      try {
        let { runtime } = await setup({ durableStorage: storage, initialAgentLocked: true });
        await runtime.dispose();
        ({ runtime } = await setup({ durableStorage: storage }));
        expect(runtime.agentLocked()).toBe(true);
        await runtime.setAgentLock(false);
        await runtime.dispose();
        ({ runtime } = await setup({ durableStorage: storage, initialAgentLocked: true }));
        expect(runtime.agentLocked()).toBe(false);
        await runtime.dispose();
      } finally {
        close.mockRestore();
        await storage.close(BACKGROUND_CONTEXT);
      }
    });

    it('rejects an invalid creation lock before opening storage', async () => {
      await expect(setup({ initialAgentLocked: 'yes' as unknown as boolean })).rejects.toThrow('Initial agent lock');
    });
  });

  it('chains existing payload callbacks and does not override independent non-Codex priority', async () => {
    const existing = vi.fn(async (payload: unknown) => ({
      ...(payload as object),
      original: true,
      service_tier: 'priority',
    }));
    let callback: ((payload: unknown, model: Model<Api>) => Promise<unknown>) | undefined;
    const complete = vi.fn<Models['complete']>(async (_model, _request, opts) => {
      callback = opts?.onPayload as typeof callback;
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
        stopReason: 'stop',
        usage,
      };
    });
    const registry = {
      getModels: () => [model],
      getAvailable: async () => [model],
      getModel: () => model,
      complete,
    } as unknown as Models;
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      durableStorage: new MemoryStorage(),
      models: registry,
      model,
      beforePayload: (event) => ({ payload: { ...(event.payload as object), host: true } }),
    });
    try {
      await runtime.completeModel!(model, { messages: [] }, { onPayload: existing });
      expect(await callback!({ base: true }, model)).toEqual({
        base: true,
        original: true,
        host: true,
        service_tier: 'priority',
      });
      expect(existing).toHaveBeenCalledOnce();
    } finally {
      await runtime.dispose();
    }
  });
  it('summarizes a rewind through guarded Models and commits the summary to the selected fork', async () => {
    const { runtime, models, streamSimple } = await setup({}, [
      response([{ type: 'text', text: 'first' }]),
      response([{ type: 'text', text: 'abandoned' }]),
      response([{ type: 'text', text: 'continued' }]),
    ]);
    const complete = vi
      .spyOn(models, 'complete')
      .mockImplementation(async () => response([{ type: 'text', text: 'retained decisions' }]).result());
    try {
      await runtime.prompt('one');
      const target = (await runtime.readEntries()).leafId!;
      await runtime.prompt('two');
      const branch = await runtime.navigateTree(target, { summarize: true, customInstructions: 'Keep decisions' });
      expect(complete).toHaveBeenCalledOnce();
      expect(JSON.stringify(complete.mock.calls[0]?.[1])).toContain('Keep decisions');
      expect(
        branch.entries.some((entry) => entry.type === 'branch_summary' && entry.summary === 'retained decisions'),
      ).toBe(true);
      expect(JSON.stringify(branch.entries)).not.toContain('abandoned');
      await runtime.prompt('continue');
      expect(JSON.stringify(streamSimple.mock.calls[2]?.[1])).toContain('retained decisions');
    } finally {
      await runtime.dispose();
    }
  });
  it('cancels an asynchronous summary without switching the active conversation', async () => {
    const { runtime, models } = await setup();
    let finish!: (message: AssistantMessage) => void;
    const complete = vi.spyOn(models, 'complete').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      await runtime.prompt('one');
      const original = runtime.lane.id;
      const target = (await runtime.readEntries()).leafId!;
      const navigation = runtime.navigateTree(target, { summarize: true });
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
      await runtime.abort((await runtime.readLifecycle()).operation!.id);
      expect((await navigation).cancelled).toBe(true);
      expect(runtime.lane.id).toBe(original);
      finish(await response([{ type: 'text', text: 'late summary' }]).result());
    } finally {
      await runtime.dispose();
    }
  });
  it('releases real SQLite ownership when runtime startup fails and permits retry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runtime-startup-'));
    const historyOwnership = createHistoryOwnership({ sourceFormat: 'sqlite' });
    const file = path.join(root, 'durable-v1', 'startup.sqlite');
    try {
      await expect(
        createDirectHarnessRuntime({ cwd: root, sessionsRoot: root, sessionId: 'startup', historyOwnership }),
      ).rejects.toThrow('Models');
      expect(fs.existsSync(historyOwnershipLockPath(file))).toBe(false);
      const fixture = await setup();
      const { models } = fixture;
      await fixture.runtime.dispose();
      const runtime = await createDirectHarnessRuntime({
        cwd: root,
        sessionsRoot: root,
        sessionId: 'startup',
        historyOwnership,
        models,
        model,
      });
      await runtime.dispose();
      expect(fs.existsSync(historyOwnershipLockPath(file))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('persists inherited Fast independently on reopen and preserves thinking independence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runtime-fast-'));
    const codexModel = { ...model, provider: 'openai-codex', api: 'openai-codex-responses' } as Model<Api>;
    const registry = {
      getModels: () => [codexModel],
      getAvailable: async () => [codexModel],
      getModel: () => codexModel,
    } as unknown as Models;
    const open = (initialFastMode?: boolean) =>
      createDirectHarnessRuntime({
        cwd: root,
        sessionsRoot: root,
        sessionId: 'fast',
        historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
        models: registry,
        model: codexModel,
        ...(initialFastMode === undefined ? {} : { initialFastMode }),
      });
    let runtime = await open(true);
    try {
      expect((await runtime.readState()).fastMode).toBe(true);
      await runtime.setThinkingLevel('high');
      await runtime.dispose();
      runtime = await open();
      expect(await runtime.readState()).toMatchObject({ fastMode: true, thinkingLevel: 'high' });
      expect(
        (await runtime.readEntries()).entries.findLast(
          (entry) => entry.type === 'custom' && entry.customType === 'doompi.fast-mode',
        ),
      ).toMatchObject({ data: { enabled: true, sessionId: 'fast' } });
      await runtime.setFastMode(false);
      await runtime.dispose();
      runtime = await open(true);
      expect((await runtime.readState()).fastMode).toBe(false);
      expect(
        (await runtime.readEntries()).entries.findLast(
          (entry) => entry.type === 'custom' && entry.customType === 'doompi.fast-mode',
        ),
      ).toMatchObject({ data: { enabled: false, sessionId: 'fast' } });
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('repairs arguments once before durable validation and tool hooks', async () => {
    const prepareArguments = vi.fn((args: unknown) => ({ value: String((args as { value: unknown }).value) }));
    const execute = vi.fn(async () => ({ content: [] }));
    const beforeTool = vi.fn();
    const { runtime } = await setup(
      {
        tools: [
          {
            name: 'fixture',
            description: 'test',
            parameters: Type.Object({ value: Type.String() }),
            prepareArguments,
            execute,
          },
        ],
        beforeTool,
      },
      [
        response([{ type: 'toolCall', id: 'call', name: 'fixture', arguments: { value: 12 } }], 'toolUse'),
        response([{ type: 'text', text: 'done' }]),
      ],
    );
    try {
      await runtime.prompt('repair');
      expect(prepareArguments).toHaveBeenCalledOnce();
      expect(beforeTool.mock.calls[0]?.[0].args).toEqual({ value: '12' });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await runtime.dispose();
    }
  });
});
