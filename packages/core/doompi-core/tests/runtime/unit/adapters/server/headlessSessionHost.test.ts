import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import type { Api, Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DoomHeadlessSession } from '../../../../../src/exports/headless';
import { DOOM_NOTIFICATION_ENTRY_TYPE } from '../../../../../src/exports/notification';
import { createHeadlessSessionHost } from '../../../../../src/systems/main/adapters/headlessSessionHost';

const model: Model<Api> = {
  id: 'test-model',
  name: 'Test model',
  provider: 'test-provider',
  api: 'test-api',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  contextWindow: 65_536,
  maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const cleanup: Array<() => Promise<void> | void> = [];

async function fixture(): Promise<{
  session: DoomHeadlessSession;
  runtime: Awaited<ReturnType<typeof createHeadlessSessionHost>>['runtime'];
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-headless-session-'));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }),
  );
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  vi.spyOn(ModelRuntime, 'create').mockResolvedValue({
    getModel: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
    getModels: () => [model],
    getAvailable: async () => [model],
  } as unknown as ModelRuntime);
  const context = new Context();
  const host = await createHeadlessSessionHost({
    cwd,
    repoRoot: cwd,
    sessionId: 'headless-session-mapping',
    sessionName: 'Headless session mapping',
    agentArgs: [],
    environment: {},
    candidates: [],
    piExtensions: false,
    selection: { majorMode: 'test', activeLayers: [], domains: [], state: {} },
  });
  host.prepareFacets(context);
  cleanup.push(async () => {
    await host.dispose();
    await context.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { session: host.host!.context.session, runtime: host.runtime };
}

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('headless session facet surface', () => {
  it('maps prompt and admitPrompt deliveries onto the runtime', async () => {
    const { session, runtime } = await fixture();
    const prompt = vi.spyOn(runtime, 'prompt').mockResolvedValue(undefined);
    const steer = vi.spyOn(runtime, 'steer').mockResolvedValue(undefined);
    const followUp = vi.spyOn(runtime, 'followUp').mockResolvedValue(undefined);
    const submitPrompt = vi.spyOn(runtime, 'submitPrompt').mockResolvedValue({ settled: Promise.resolve() });

    // prompt awaits the turn, so a streaming delivery only enqueues into a running turn.
    await session.prompt('steered', 'steer');
    await session.prompt('queued', 'followUp');
    await session.prompt('plain');
    // admitPrompt returns at admission, and 'steer' also wakes an idle agent.
    await session.admitPrompt!('admitted steer', 'steer');
    // followUp stays enqueue-only: voiceServer/index.ts:120 asks for 'followUp' while idle whenever
    // a capture is queued, so routing it through submitPrompt would start an unrequested turn.
    await session.admitPrompt!('admitted follow up', 'followUp');
    await session.admitPrompt!('admitted plain');

    expect(steer).toHaveBeenCalledExactlyOnceWith('steered');
    expect(followUp.mock.calls).toEqual([['queued'], ['admitted follow up']]);
    expect(prompt).toHaveBeenCalledExactlyOnceWith('plain');
    expect(submitPrompt).toHaveBeenNthCalledWith(1, 'admitted steer', undefined, 'steer');
    expect(submitPrompt).toHaveBeenNthCalledWith(2, 'admitted plain', undefined, undefined);
    expect(submitPrompt).toHaveBeenCalledTimes(2);
  });

  it('reports an admitted prompt that fails after admission to the operator', async () => {
    const { session, runtime } = await fixture();
    vi.spyOn(runtime, 'submitPrompt').mockResolvedValue({ settled: Promise.reject(new Error('turn failed')) });
    const appendCustomEntry = vi.spyOn(runtime, 'appendCustomEntry').mockResolvedValue('entry');

    await session.admitPrompt!('admitted');
    await new Promise((resolve) => setImmediate(resolve));

    expect(appendCustomEntry).toHaveBeenCalledExactlyOnceWith(
      DOOM_NOTIFICATION_ENTRY_TYPE,
      expect.objectContaining({ body: 'turn failed', level: 'error' }),
    );
  });

  it('derives activity from the runtime state', async () => {
    const { session, runtime } = await fixture();
    const readState = vi.spyOn(runtime, 'readState');

    readState.mockResolvedValueOnce({ pendingMessageCount: 2, isStreaming: true, isCompacting: false });
    await expect(session.activity()).resolves.toEqual({ hasPendingMessages: true, isIdle: false });
    readState.mockResolvedValueOnce({ pendingMessageCount: 0, isStreaming: false, isCompacting: true });
    await expect(session.activity()).resolves.toEqual({ hasPendingMessages: false, isIdle: false });
    readState.mockResolvedValueOnce({ pendingMessageCount: 0, isStreaming: false, isCompacting: false });
    await expect(session.activity()).resolves.toEqual({ hasPendingMessages: false, isIdle: true });
  });
});
