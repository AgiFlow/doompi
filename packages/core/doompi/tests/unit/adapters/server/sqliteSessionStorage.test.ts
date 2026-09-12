import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { openSqliteSessionStorage } from '../../../../src/services/sqliteSessionStorage';
import { createHistoryOwnership } from '../../../../src/services/historyOwnership';
import { createDirectHarnessRuntime } from '../../../../src/controllers/directHarnessRuntime';
import { registerNativeChild } from '../../../../src/controllers/nativeChildRuntimes';
import { createThreadJournals } from '../../../../src/controllers/threadJournals';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Models,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

it('persists server entries, rejects a second writer, and reopens by session id', async () => {
  const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-sqlite-'));
  directories.push(sessionsRoot);
  const options = {
    sessionsRoot,
    sessionId: 'test',
    historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
  };
  const first = await openSqliteSessionStorage(options, BACKGROUND_CONTEXT);
  try {
    const branch = await first.session.createBranch('main', null, BACKGROUND_CONTEXT);
    await branch.appendMessage({ role: 'user', content: 'durable', timestamp: 100 }, BACKGROUND_CONTEXT);
    await expect(openSqliteSessionStorage(options, BACKGROUND_CONTEXT)).rejects.toThrow('lock');
  } finally {
    await first.session.close(BACKGROUND_CONTEXT);
    await first.repository.close(BACKGROUND_CONTEXT);
    await first.historyLease.release();
  }
  const second = await openSqliteSessionStorage(options, BACKGROUND_CONTEXT);
  try {
    const entries = await second.session.findEntries({ order: 'asc', limit: 10 }, BACKGROUND_CONTEXT);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'message', message: { content: 'durable' } });
    const header = await fs.readFile(second.sessionFile);
    expect(header.subarray(0, 16).toString()).toBe('SQLite format 3\u0000');
  } finally {
    await second.session.close(BACKGROUND_CONTEXT);
    await second.repository.close(BACKGROUND_CONTEXT);
    await second.historyLease.release();
  }
});

it('streams a real harness turn and stores exactly one settlement at its original position', async () => {
  const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-sqlite-turn-'));
  directories.push(sessionsRoot);
  const model: Model<Api> = {
    id: 'test',
    provider: 'test',
    name: 'Test',
    api: 'test',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65536,
    maxTokens: 100,
  };
  const models = {
    getModels: () => [model],
    getModel: () => model,
    getAvailable: async () => [model],
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: 'start', partial: { ...message, content: [] } });
      stream.push({
        type: 'text_start',
        contentIndex: 0,
        partial: { ...message, content: [{ type: 'text', text: '' }] },
      });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'hello', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    },
  } as unknown as Models;
  const options = {
    storage: 'sqlite' as const,
    sessionId: 'turn',
    sessionsRoot,
    cwd: sessionsRoot,
    model,
    models,
    historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
  };
  const runtime = await createDirectHarnessRuntime(options);
  const file = path.join(sessionsRoot, 'turn.sqlite');
  const release = registerNativeChild(file, runtime);
  const threads = createThreadJournals({ resolve: () => file });
  const live: Record<string, unknown>[] = [];
  threads.onFrame(({ frame }) => live.push(frame));
  expect(threads.subscribe('parent', 'child')).toMatchObject([{ type: 'transcript_state' }]);
  const frames: Record<string, unknown>[] = [];
  runtime.onPresentationFrame((frame) => frames.push(frame));
  try {
    await runtime.prompt('first');
    await runtime.prompt('second');
    expect(frames.filter((frame) => frame.type === 'agent_settled')).toHaveLength(2);
    expect(live.some((frame) => frame.type === 'transcript_state')).toBe(true);
    expect((await threads.readPage('parent', 'child', {}, BACKGROUND_CONTEXT)).entries.length).toBe(6);
  } finally {
    threads.close();
    release();
    await runtime.dispose();
  }
  expect((await threads.readPage('parent', 'child', {}, BACKGROUND_CONTEXT)).entries.length).toBe(6);
  const restored = await openSqliteSessionStorage(options, BACKGROUND_CONTEXT);
  try {
    const entries = await restored.session.findEntries({ order: 'asc' }, BACKGROUND_CONTEXT);
    expect(
      entries.map((entry) =>
        entry.type === 'custom' ? entry.customType : entry.type === 'message' ? entry.message.role : entry.type,
      ),
    ).toEqual(['user', 'assistant', 'doompi.agent-settled', 'user', 'assistant', 'doompi.agent-settled']);
  } finally {
    await restored.session.close(BACKGROUND_CONTEXT);
    await restored.repository.close(BACKGROUND_CONTEXT);
    await restored.historyLease.release();
  }
});
