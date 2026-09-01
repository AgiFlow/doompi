import {
  DOOM_CONTEXT_CONTRIBUTIONS_SERVICE,
  type DoomContextContributionEntry,
  type DoomContextContributionError,
  type DoomContextContributionsService,
  type DoomContextContributionsSnapshot,
} from '@agimon-ai/doompi-extension-contracts/context-contributions';
import { Context } from '@deepseek-ai/cordis';
import {
  buildContextEntries,
  buildSessionContext,
  type CompactOptions,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadDoomConfig = vi.hoisted(() => vi.fn(() => ({ modes: {} }) as unknown));
const getHarnessState = vi.hoisted(() => vi.fn(() => ({}) as unknown));
vi.mock('@agimon-ai/doompi-config', () => ({ loadDoomConfig, getHarnessState }));

import { installAutocompactRuntime } from '../src/adapters/pi/extension.ts';
import {
  AUTOCOMPACT_EVENT,
  type AutocompactEventAttributes,
  type AutocompactTelemetry,
} from '../src/adapters/telemetry/logSinkTelemetry.ts';
import { createInitialState } from '../src/adapters/compaction/policy';
import {
  CHECKPOINT_MESSAGE_TYPE,
  CONTEXT_MESSAGE_TYPE,
  RUNTIME_STATE_MESSAGE_TYPE,
  STATE_CUSTOM_TYPE,
} from '../src/types/constants.ts';

const STRUCTURED_CHECKPOINT = `## Goal
Retain important context.
## Constraints & Preferences
Preserve asynchronous parent work.
## Progress
### Done
Checkpoint generated.
### In Progress
Compaction commit.
### Blocked
None.
## Key Decisions
Use asynchronous summarization.
## Next Steps
Continue implementation.
## Critical Context
src/extension.ts`;
const COMPACT_CHECKPOINT = `<shouldCompact>true</shouldCompact>\n${STRUCTURED_CHECKPOINT}`;
const DEFER_CHECKPOINT = `<shouldCompact>false</shouldCompact>\n${STRUCTURED_CHECKPOINT}`;
const NATIVE_COMPACTION_REASONS = ['manual', 'threshold', 'overflow'] as const;

type Handler = (event: never, context: ExtensionContext) => unknown;

function assistantEntry(id: string, text: string, parentId: string | null): SessionEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-03T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
    },
  };
}

function contextSnapshot(
  entries: readonly DoomContextContributionEntry[] = [],
  errors: readonly DoomContextContributionError[] = [],
): DoomContextContributionsSnapshot {
  return { entries, errors };
}

function fixedContextService(
  generation: string,
  snapshot: DoomContextContributionsSnapshot,
): DoomContextContributionsService {
  return {
    generation,
    register: () => ({ dispose: () => undefined }),
    snapshot: () => snapshot,
  };
}

function createHarness(
  initialContextContributions: DoomContextContributionsSnapshot = contextSnapshot(),
  options: { provideContextService?: boolean } = {},
) {
  const entries: SessionEntry[] = [];
  const handlers = new Map<string, Handler>();
  const compactCalls: CompactOptions[] = [];
  const labels: Array<{ entryId: string; label: string | undefined }> = [];
  const notify = vi.fn();
  const setStatus = vi.fn();
  const runInSpan = vi.fn(
    async (
      _name: string,
      _attributes: AutocompactEventAttributes,
      callback: () => Promise<unknown>,
    ): Promise<unknown> => callback(),
  );
  const telemetry: AutocompactTelemetry = {
    recordError: vi.fn(async () => undefined),
    recordWarning: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    runInSpan: async <T>(
      name: string,
      attributes: AutocompactEventAttributes,
      callback: () => Promise<T>,
    ): Promise<T> => (await runInSpan(name, attributes, callback)) as T,
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
  const generationRequests: Array<{
    messages: Array<{ role: string; content?: unknown }>;
    instructions: string;
    previousCheckpoint?: string;
    signal: AbortSignal;
  }> = [];
  const pendingGenerations: Array<{
    resolve: (output: string) => void;
    reject: (error: Error) => void;
  }> = [];
  let nextId = 1;
  let contextContributions = initialContextContributions;
  let idle = true;
  let pendingMessages = false;
  let usage: { tokens: number | null; contextWindow: number; percent: number | null } = {
    tokens: 0,
    contextWindow: 200_000,
    percent: 0,
  };

  const append = (entry: SessionEntry): void => {
    entries.push(entry);
  };
  const leafId = (): string | null => entries.at(-1)?.id ?? null;

  const pi = {
    events: {},
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      append({
        type: 'custom',
        id: `entry-${nextId++}`,
        parentId: leafId(),
        timestamp: '2026-08-03T00:00:00.000Z',
        customType,
        data,
      });
    }),
    sendMessage: vi.fn((message: { customType: string; content: string; display: boolean; details?: unknown }) => {
      append({
        type: 'custom_message',
        id: `entry-${nextId++}`,
        parentId: leafId(),
        timestamp: '2026-08-03T00:00:00.000Z',
        ...message,
      });
    }),
    setLabel: vi.fn((entryId: string, label: string | undefined) => labels.push({ entryId, label })),
    getActiveTools: vi.fn(() => []),
  } as unknown as ExtensionAPI;

  const context = {
    cwd: '/repo',
    hasUI: true,
    ui: { notify, setStatus },
    sessionManager: {
      getSessionId: () => 'session-1',
      getLeafId: leafId,
      getBranch: () => [...entries],
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
    },
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    getContextUsage: () => usage,
    compact: vi.fn((options?: CompactOptions) => compactCalls.push(options ?? {})),
  } as unknown as ExtensionContext;

  const cordis = new Context();
  if (options.provideContextService ?? true) {
    const contextContributionsService: DoomContextContributionsService = {
      generation: 'autocompact-test',
      register: () => ({ dispose: () => undefined }),
      snapshot: () => contextContributions,
    };
    cordis.provide(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE, contextContributionsService);
  }
  installAutocompactRuntime(cordis, pi, {
    generateCheckpoint: (input) => {
      generationRequests.push({
        messages: input.messages as Array<{ role: string; content?: unknown }>,
        instructions: input.instructions,
        signal: input.signal,
        ...(input.previousCheckpoint ? { previousCheckpoint: input.previousCheckpoint } : {}),
      });
      return new Promise<string>((resolve, reject) => pendingGenerations.push({ resolve, reject }));
    },
    telemetry,
  });
  pi.on('session_shutdown', () => cordis.fiber.dispose());

  return {
    appendAssistant(text = STRUCTURED_CHECKPOINT) {
      const id = `assistant-${nextId++}`;
      append(assistantEntry(id, text, leafId()));
      return id;
    },
    appendCustomMessage(customType: string, content: string, details: unknown, display = false) {
      const id = `entry-${nextId++}`;
      append({
        type: 'custom_message',
        id,
        parentId: leafId(),
        timestamp: '2026-08-03T00:00:00.000Z',
        customType,
        content,
        display,
        details,
      });
      return id;
    },
    appendCompaction(id: string) {
      append({ ...compactionEntry(id), parentId: leafId() });
      return id;
    },
    appendPlan(content: string, path = '/repo/plans/current.md') {
      append({
        type: 'custom',
        id: `entry-${nextId++}`,
        parentId: leafId(),
        timestamp: '2026-08-03T00:00:00.000Z',
        customType: 'agent-harness-plan-document',
        data: { content, path },
      });
    },
    appendState(data: unknown) {
      append({
        type: 'custom',
        id: `entry-${nextId++}`,
        parentId: leafId(),
        timestamp: '2026-08-03T00:00:00.000Z',
        customType: STATE_CUSTOM_TYPE,
        data,
      });
    },
    compactCalls,
    context,
    cordis,
    generationRequests,
    async contextProjection() {
      const result = await handlers.get('context')?.(
        { type: 'context', messages: buildSessionContext(entries).messages } as never,
        context,
      );
      return result as { messages?: Array<{ role: string; content?: unknown }> } | undefined;
    },
    emit: async (name: string, event: Record<string, unknown> = {}) =>
      handlers.get(name)?.({ type: name, ...event } as never, context),
    entries,
    async finishLatest(output: string | undefined, failed = false) {
      const generation = pendingGenerations.shift();
      if (!generation) throw new Error('No checkpoint generation is available.');
      if (failed) generation.reject(new Error('summarizer unavailable'));
      else generation.resolve(output ?? '');
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    handlers,
    labels,
    notify,
    pi,
    runInSpan,
    setStatus,
    telemetry,
    setIdle(value: boolean) {
      idle = value;
    },
    setPendingMessages(value: boolean) {
      pendingMessages = value;
    },
    setContextContributions(value: DoomContextContributionsSnapshot) {
      contextContributions = value;
    },
    setUsage(tokens: number | null, contextWindow = 200_000) {
      usage = {
        tokens,
        contextWindow,
        percent: tokens === null ? null : (tokens / contextWindow) * 100,
      };
    },
  };
}

function beforeCompactEvent(
  harness: ReturnType<typeof createHarness>,
  reason: 'manual' | 'threshold' | 'overflow',
  customInstructions?: string,
): SessionBeforeCompactEvent {
  return {
    type: 'session_before_compact',
    reason,
    willRetry: false,
    customInstructions,
    branchEntries: [...harness.entries],
    preparation: {
      firstKeptEntryId: harness.entries[0]?.id ?? 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 150_000,
      fileOps: {
        read: new Set(['src/read.ts']),
        written: new Set<string>(),
        edited: new Set(['src/extension.ts']),
      },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    signal: new AbortController().signal,
  };
}

function compactionEntry(id: string): SessionEntry & { type: 'compaction' } {
  return {
    type: 'compaction',
    id,
    parentId: null,
    timestamp: '2026-08-03T00:00:00.000Z',
    summary: STRUCTURED_CHECKPOINT,
    firstKeptEntryId: 'keep',
    tokensBefore: 150_000,
    details: { readFiles: ['src/read.ts'], modifiedFiles: ['src/extension.ts'] },
  };
}

describe('doom autocompact extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadDoomConfig.mockReturnValue({ modes: {} });
    getHarnessState.mockReturnValue({});
  });

  it('stages pass 1 with an asynchronous LLM summary without entering the agent context', async () => {
    const harness = createHarness(
      contextSnapshot([
        {
          source: '@agimon-ai/doompi-task',
          id: 'active-tasks',
          label: 'Active tasks',
          order: 100,
          text: '- #7 [in_progress] Preserve current task state | owner: main | blocked by: 3',
        },
        {
          source: '@agimon-ai/doompi-team',
          id: 'active-team',
          label: 'Active team',
          order: 200,
          text: '- reviewer | role: subagent | agent: explorer | run: run-1',
        },
      ]),
    );
    harness.appendPlan('# Active plan\n\n1. Capture steering evidence.');
    const state = createInitialState();
    state.readFiles = ['src/read.ts'];
    state.modifiedFiles = ['src/extension.ts'];
    harness.appendState(state);
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(100_000);

    await harness.emit('agent_settled');
    await harness.emit('agent_settled');

    expect(harness.generationRequests).toHaveLength(1);
    expect(harness.generationRequests[0]?.instructions).toContain(
      'priority="user,plan,context-contributions,important-context',
    );
    expect(harness.generationRequests[0]?.instructions).toContain('# Active plan');
    expect(harness.generationRequests[0]?.instructions).toContain('#7 [in_progress] Preserve current task state');
    expect(harness.generationRequests[0]?.instructions).toContain('reviewer | role: subagent | agent: explorer');
    expect(harness.generationRequests[0]?.instructions).toContain('Read files: src/read.ts');
    expect(harness.generationRequests[0]?.instructions).toContain('Modified files: src/extension.ts');
    // Summarization has no tools, so directives aimed at an implementing agent only risk
    // being echoed back into the checkpoint body.
    expect(harness.generationRequests[0]?.instructions).not.toContain('do not modify files');
    expect(harness.generationRequests[0]?.instructions).not.toContain('continue implementation');
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    expect(harness.compactCalls).toHaveLength(0);

    await harness.finishLatest(STRUCTURED_CHECKPOINT);

    // The staged checkpoint is a session artifact for the next pass, never an agent message.
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    expect(harness.entries).toContainEqual(
      expect.objectContaining({
        type: 'custom',
        customType: CHECKPOINT_MESSAGE_TYPE,
        data: expect.objectContaining({ pass: 1, summary: STRUCTURED_CHECKPOINT }),
      }),
    );
    expect(JSON.stringify(buildSessionContext(harness.entries).messages)).not.toContain('## Goal');
  });

  it('surfaces isolated contribution failures and preserves them in the steering evidence', async () => {
    const harness = createHarness(
      contextSnapshot(
        [],
        [
          {
            source: '@agimon-ai/doompi-task',
            id: 'active-tasks',
            label: 'Active tasks',
            order: 100,
            message: 'task store is unreadable',
          },
          {
            source: '@agimon-ai/doompi-team',
            id: 'active-team',
            label: 'Active team',
            order: 200,
            message: 'team runtime is unreadable',
          },
        ],
      ),
    );
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(100_000);

    await harness.emit('agent_settled');

    expect(harness.notify).toHaveBeenCalledWith(
      'Doom autocompact context contribution degraded (@agimon-ai/doompi-task/active-tasks): task store is unreadable',
      'warning',
    );
    expect(harness.generationRequests[0]?.instructions).toContain('(unavailable: task store is unreadable)');
    expect(harness.telemetry.recordWarning).toHaveBeenCalledWith(
      AUTOCOMPACT_EVENT.contextContributionDegraded,
      expect.any(Error),
      expect.objectContaining({
        'autocompact.pass': 1,
        'pi.session.id': 'session-1',
        'autocompact.context_contribution.source': '@agimon-ai/doompi-task',
        'autocompact.context_contribution.id': 'active-tasks',
      }),
    );
    expect(harness.generationRequests[0]?.instructions).toContain('(unavailable: team runtime is unreadable)');
    expect(harness.telemetry.recordWarning).toHaveBeenCalledWith(
      AUTOCOMPACT_EVENT.contextContributionDegraded,
      expect.any(Error),
      expect.objectContaining({
        'autocompact.pass': 1,
        'pi.session.id': 'session-1',
        'autocompact.context_contribution.source': '@agimon-ai/doompi-team',
        'autocompact.context_contribution.id': 'active-team',
      }),
    );
  });

  it('drops a removed contribution broker and reads from its replacement', async () => {
    const harness = createHarness(contextSnapshot(), { provideContextService: false });
    await harness.emit('session_start', { reason: 'startup' });
    const firstService = fixedContextService(
      'context-first',
      contextSnapshot([
        {
          source: '@example/first',
          id: 'runtime',
          label: 'First runtime',
          order: 100,
          text: 'first provider state',
        },
      ]),
    );
    const firstProvider = harness.cordis.plugin((context) =>
      context.provide(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE, firstService),
    );
    await firstProvider;

    harness.appendCompaction('first-compact');
    await harness.emit('session_compact', {
      compactionEntry: compactionEntry('first-compact'),
      fromExtension: false,
      reason: 'manual',
      willRetry: false,
    });
    expect(
      harness.entries.findLast(
        (entry) => entry.type === 'custom_message' && entry.customType === RUNTIME_STATE_MESSAGE_TYPE,
      ),
    ).toMatchObject({ details: { contributions: [expect.objectContaining({ text: 'first provider state' })] } });

    await firstProvider.dispose();
    harness.appendCompaction('without-provider');
    await harness.emit('session_compact', {
      compactionEntry: compactionEntry('without-provider'),
      fromExtension: false,
      reason: 'manual',
      willRetry: false,
    });
    expect(
      harness.entries.findLast(
        (entry) => entry.type === 'custom_message' && entry.customType === RUNTIME_STATE_MESSAGE_TYPE,
      ),
    ).toMatchObject({ details: { contributions: [], contributionErrors: [] } });

    const secondService = fixedContextService(
      'context-second',
      contextSnapshot([
        {
          source: '@example/second',
          id: 'runtime',
          label: 'Second runtime',
          order: 100,
          text: 'replacement provider state',
        },
      ]),
    );
    const secondProvider = harness.cordis.plugin((context) =>
      context.provide(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE, secondService),
    );
    await secondProvider;
    harness.appendCompaction('replacement-provider');
    await harness.emit('session_compact', {
      compactionEntry: compactionEntry('replacement-provider'),
      fromExtension: false,
      reason: 'manual',
      willRetry: false,
    });
    expect(
      harness.entries.findLast(
        (entry) => entry.type === 'custom_message' && entry.customType === RUNTIME_STATE_MESSAGE_TYPE,
      ),
    ).toMatchObject({ details: { contributions: [expect.objectContaining({ text: 'replacement provider state' })] } });

    await harness.emit('session_shutdown');
  });

  it('chains each staged summary with only the parent messages added after its snapshot', async () => {
    const harness = createHarness();
    harness.appendAssistant('Before stage 1.');
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(100_000);
    await harness.emit('agent_settled');
    await harness.finishLatest(STRUCTURED_CHECKPOINT.replace('Checkpoint generated.', 'Stage 1 generated.'));

    harness.appendAssistant('After stage 1.');
    harness.setUsage(150_000);
    await harness.emit('agent_settled');

    expect(harness.generationRequests).toHaveLength(2);
    expect(harness.generationRequests[1]?.previousCheckpoint).toContain('Stage 1 generated.');
    expect(JSON.stringify(harness.generationRequests[1]?.messages)).toContain('After stage 1.');
    expect(JSON.stringify(harness.generationRequests[1]?.messages)).not.toContain('Before stage 1.');
    await harness.finishLatest(DEFER_CHECKPOINT.replace('Checkpoint generated.', 'Stage 2 generated.'));

    harness.appendAssistant('After stage 2.');
    harness.setUsage(190_000);
    await harness.emit('agent_settled');

    expect(harness.generationRequests).toHaveLength(3);
    expect(harness.generationRequests[2]?.previousCheckpoint).toContain('Stage 2 generated.');
    expect(JSON.stringify(harness.generationRequests[2]?.messages)).toContain('After stage 2.');
    expect(JSON.stringify(harness.generationRequests[2]?.messages)).not.toContain('After stage 1.');

    await harness.finishLatest(STRUCTURED_CHECKPOINT.replace('Checkpoint generated.', 'Stage 3 generated.'));
    expect(harness.compactCalls).toHaveLength(0);
    expect(harness.entries).toContainEqual(
      expect.objectContaining({ type: 'custom_message', customType: CONTEXT_MESSAGE_TYPE, display: false }),
    );
  });

  it('commits a hidden logical checkpoint while preserving renderable history and newer parent messages', async () => {
    const harness = createHarness();
    harness.appendPlan('# Exact plan body that is injected elsewhere.', '/repo/plans/runtime.md');
    const snapshotLeafId = harness.appendAssistant('Parent transcript before summarization.');
    const state = createInitialState();
    state.pass = 2;
    harness.appendState(state);
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(150_000);
    await harness.emit('agent_settled');

    expect(harness.generationRequests).toHaveLength(1);
    const firstNewMessageId = harness.appendAssistant('Parent work completed while the summary was generated.');
    harness.setIdle(false);
    await harness.finishLatest(COMPACT_CHECKPOINT);
    harness.appendAssistant('More parent work before the safe commit point.');
    harness.setContextContributions(
      contextSnapshot([
        {
          source: '@agimon-ai/doompi-task',
          id: 'active-tasks',
          label: 'Active tasks',
          order: 100,
          text: '- #8 [in_progress] Resume implementation | active: Implementing runtime state | owner: main | blocked by: 4 | delegation: worker (failed) | error: worker stopped',
        },
        {
          source: '@agimon-ai/doompi-team',
          id: 'active-team',
          label: 'Active team',
          order: 200,
          text: '- main | role: main\n- worker | role: subagent | agent: backend-dev | run: run-8',
        },
      ]),
    );
    harness.setIdle(true);
    await harness.emit('agent_settled');

    expect(harness.compactCalls).toHaveLength(0);
    const marker = harness.entries.find(
      (entry) => entry.type === 'custom_message' && entry.customType === CONTEXT_MESSAGE_TYPE,
    );
    expect(marker).toMatchObject({
      display: false,
      details: {
        doomAutocompact: { pass: 2, snapshotLeafId, tokensBefore: 150_000 },
      },
    });
    expect(JSON.stringify(marker)).toContain('Parent work completed while the summary was generated.');
    expect(JSON.stringify(marker)).toContain('More parent work before the safe commit point.');
    const runtimeState = harness.entries.find(
      (entry) => entry.type === 'custom_message' && entry.customType === RUNTIME_STATE_MESSAGE_TYPE,
    );
    expect(runtimeState).toMatchObject({
      display: false,
      details: {
        version: 2,
        planPath: '/repo/plans/runtime.md',
        contributions: [
          {
            source: '@agimon-ai/doompi-task',
            id: 'active-tasks',
            label: 'Active tasks',
            order: 100,
            text: expect.stringContaining('Resume implementation'),
          },
          {
            source: '@agimon-ai/doompi-team',
            id: 'active-team',
            label: 'Active team',
            order: 200,
            text: expect.stringContaining('worker | role: subagent'),
          },
        ],
        contributionErrors: [],
      },
    });
    expect(JSON.stringify(runtimeState)).not.toContain('Large implementation detail');
    expect(JSON.stringify(runtimeState)).not.toContain('large delegated output');
    expect(JSON.stringify(runtimeState)).not.toContain('Finished task');
    expect(harness.entries.indexOf(runtimeState as SessionEntry)).toBeGreaterThan(
      harness.entries.indexOf(marker as SessionEntry),
    );

    const renderable = buildContextEntries(harness.entries, harness.entries.at(-1)?.id ?? null);
    expect(renderable.map((entry) => entry.id)).toContain(snapshotLeafId);
    expect(renderable.map((entry) => entry.id)).toContain(firstNewMessageId);

    const projection = await harness.contextProjection();
    expect(projection?.messages?.[0]?.role).toBe('compactionSummary');
    expect(JSON.stringify(projection?.messages)).not.toContain('Parent transcript before summarization.');
    expect(JSON.stringify(projection?.messages)).toContain('Parent work completed while the summary was generated.');
    expect(JSON.stringify(projection?.messages)).toContain('More parent work before the safe commit point.');
    expect(JSON.stringify(projection?.messages)).toContain('compaction-runtime-state');
    expect(harness.runInSpan).toHaveBeenCalledWith(
      'doom_autocompact.checkpoint',
      expect.objectContaining({ 'autocompact.pass': 2 }),
      expect.any(Function),
    );
    expect(harness.telemetry.recordEvent).toHaveBeenCalledWith(
      AUTOCOMPACT_EVENT.contextCommitted,
      expect.objectContaining({ 'autocompact.pass': 2, 'autocompact.message_count.retained': 2 }),
    );
    expect(harness.telemetry.recordEvent).toHaveBeenCalledWith(
      AUTOCOMPACT_EVENT.contextApplied,
      expect.objectContaining({ 'autocompact.pass': 2 }),
    );
  });

  it('drains crossed checkpoint thresholds in FIFO order before the hard compaction', async () => {
    const harness = createHarness();
    harness.appendAssistant('Large parent transcript.');
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(190_000);
    await harness.emit('agent_settled');

    expect(harness.generationRequests).toHaveLength(1);
    expect(harness.generationRequests[0]?.instructions).toContain('checkpoint pass 1');
    expect(harness.compactCalls).toHaveLength(0);

    await harness.finishLatest(STRUCTURED_CHECKPOINT);
    expect(harness.generationRequests).toHaveLength(2);
    expect(harness.generationRequests[1]?.instructions).toContain('checkpoint pass 2');
    expect(harness.compactCalls).toHaveLength(0);

    await harness.finishLatest(DEFER_CHECKPOINT);
    expect(harness.generationRequests).toHaveLength(3);
    expect(harness.generationRequests[2]?.instructions).toContain('checkpoint pass 3');
    expect(harness.compactCalls).toHaveLength(0);

    await harness.finishLatest(STRUCTURED_CHECKPOINT);
    expect(harness.compactCalls).toHaveLength(0);
    const marker = harness.entries.find(
      (entry) => entry.type === 'custom_message' && entry.customType === CONTEXT_MESSAGE_TYPE,
    );
    expect(marker).toBeDefined();
    expect(harness.labels).toContainEqual({ entryId: marker?.id, label: 'autocompact:c1:p3' });
    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Asynchronous compaction completed.') }),
      { triggerTurn: true, deliverAs: 'steer' },
    );
  });

  it('stages a declined pass 2 checkpoint and advances without compacting', async () => {
    const harness = createHarness();
    const state = createInitialState();
    state.pass = 2;
    harness.appendState(state);
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(150_000);
    await harness.emit('agent_settled');

    await harness.finishLatest(DEFER_CHECKPOINT);

    expect(harness.compactCalls).toHaveLength(0);
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    expect(harness.entries).toContainEqual(
      expect.objectContaining({
        type: 'custom',
        customType: CHECKPOINT_MESSAGE_TYPE,
        data: expect.objectContaining({ pass: 2, summary: STRUCTURED_CHECKPOINT }),
      }),
    );
  });

  it('uses the compacted token count as the baseline for future thresholds', async () => {
    const harness = createHarness(
      contextSnapshot([
        {
          source: '@agimon-ai/doompi-task',
          id: 'active-tasks',
          label: 'Active tasks',
          order: 100,
          text: '- #3 [pending] Resume after manual compact',
        },
        {
          source: '@agimon-ai/doompi-team',
          id: 'active-team',
          label: 'Active team',
          order: 200,
          text: '- main | role: main',
        },
      ]),
    );
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(null);
    harness.appendCompaction('manual-compact');
    await harness.emit('session_compact', {
      compactionEntry: compactionEntry('manual-compact'),
      fromExtension: false,
      reason: 'manual',
      willRetry: false,
    });

    expect(harness.entries).toContainEqual(
      expect.objectContaining({
        type: 'custom_message',
        customType: RUNTIME_STATE_MESSAGE_TYPE,
        display: false,
        details: expect.objectContaining({
          version: 2,
          contributions: [
            expect.objectContaining({
              source: '@agimon-ai/doompi-task',
              text: expect.stringContaining('#3 [pending]'),
            }),
            expect.objectContaining({ source: '@agimon-ai/doompi-team', text: expect.stringContaining('role: main') }),
          ],
        }),
      }),
    );

    harness.setUsage(30_000);
    await harness.emit('agent_settled');
    expect(harness.generationRequests).toHaveLength(0);

    harness.appendAssistant('First response measured against the compacted context.');
    await harness.emit('agent_settled');
    expect(harness.generationRequests).toHaveLength(0);

    harness.setUsage(114_999);
    await harness.emit('agent_settled');
    expect(harness.generationRequests).toHaveLength(0);

    harness.setUsage(115_000);
    await harness.emit('agent_settled');
    expect(harness.generationRequests).toHaveLength(1);
    expect(harness.notify).toHaveBeenCalledWith('Doom autocompact baseline captured at 30000 tokens.', 'info');
  });

  it('records delegation failures and retries only after the parent branch advances', async () => {
    const harness = createHarness();
    harness.appendAssistant('Large parent transcript.');
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(190_000);
    await harness.emit('agent_settled');
    await harness.finishLatest(undefined, true);

    await harness.emit('agent_settled');
    expect(harness.generationRequests).toHaveLength(1);
    expect(harness.notify).toHaveBeenCalledWith(
      'Doom autocompact summarization pass 1 failed: summarizer unavailable',
      'error',
    );
    expect(harness.telemetry.recordError).toHaveBeenCalledWith(
      AUTOCOMPACT_EVENT.checkpointFailed,
      expect.any(Error),
      expect.objectContaining({ 'autocompact.pass': 1 }),
    );

    harness.appendAssistant('The parent branch advanced.');
    await harness.emit('agent_settled');
    expect(harness.generationRequests).toHaveLength(2);
  });

  it('uses the projected logical context when the next compaction cycle starts', async () => {
    const harness = createHarness();
    harness.appendAssistant('Archived parent transcript.');
    const state = createInitialState();
    state.pass = 2;
    harness.appendState(state);
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(150_000);
    await harness.emit('agent_settled');
    await harness.finishLatest(COMPACT_CHECKPOINT);

    harness.appendAssistant('Work after logical compaction.');
    harness.setUsage(20_000);
    await harness.emit('agent_settled');
    harness.setUsage(110_000);
    await harness.emit('agent_settled');

    expect(harness.generationRequests).toHaveLength(2);
    expect(harness.generationRequests[1]?.messages[0]?.role).toBe('compactionSummary');
    expect(JSON.stringify(harness.generationRequests[1]?.messages)).not.toContain('Archived parent transcript.');
    expect(JSON.stringify(harness.generationRequests[1]?.messages)).toContain('Work after logical compaction.');
  });

  it('records a successful pass 2 logical commit and leaves native compaction unused', async () => {
    const harness = createHarness();
    harness.appendAssistant('Parent transcript.');
    const state = createInitialState();
    state.pass = 2;
    harness.appendState(state);
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(150_000);
    await harness.emit('agent_settled');
    await harness.finishLatest(COMPACT_CHECKPOINT);

    const marker = harness.entries.find(
      (entry) => entry.type === 'custom_message' && entry.customType === CONTEXT_MESSAGE_TYPE,
    );
    expect(marker).toBeDefined();
    expect(harness.labels).toContainEqual({ entryId: marker?.id, label: 'autocompact:c1:p2' });
    expect(harness.compactCalls).toHaveLength(0);
    expect(
      harness.entries.findLast((entry) => entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE),
    ).toMatchObject({ data: { cycle: 2, pass: 1, checkpointQueue: [], baselinePending: true } });
  });

  it('rejects incomplete summarizer output and resumes a persisted ready checkpoint', async () => {
    const invalidHarness = createHarness();
    const invalidState = createInitialState();
    invalidState.pass = 2;
    invalidHarness.appendState(invalidState);
    await invalidHarness.emit('session_start', { reason: 'startup' });
    invalidHarness.setUsage(150_000);
    await invalidHarness.emit('agent_settled');
    await invalidHarness.finishLatest('Incomplete checkpoint.');
    expect(invalidHarness.compactCalls).toHaveLength(0);
    expect(invalidHarness.notify).toHaveBeenCalledWith(
      'Doom autocompact summarization pass 2 returned an incomplete checkpoint.',
      'error',
    );
    expect(invalidHarness.telemetry.recordError).toHaveBeenCalledWith(
      AUTOCOMPACT_EVENT.checkpointInvalid,
      expect.any(Error),
      expect.objectContaining({ 'autocompact.pass': 2 }),
    );

    const restoredHarness = createHarness();
    const snapshotLeafId = restoredHarness.appendAssistant('Snapshot.');
    const restoredState = createInitialState();
    restoredState.phase = 'checkpoint_ready';
    restoredState.requestId = 'restored-request';
    restoredState.snapshotLeafId = snapshotLeafId;
    restoredState.pendingCheckpoint = STRUCTURED_CHECKPOINT;
    restoredHarness.appendState(restoredState);
    await restoredHarness.emit('session_start', { reason: 'resume' });
    expect(restoredHarness.entries).toContainEqual(
      expect.objectContaining({
        type: 'custom',
        customType: CHECKPOINT_MESSAGE_TYPE,
        data: expect.objectContaining({ pass: 1, summary: STRUCTURED_CHECKPOINT }),
      }),
    );
  });

  it('abandons a pass whose summarizer keeps returning an incomplete checkpoint', async () => {
    const harness = createHarness();
    harness.appendAssistant('Large parent transcript.');
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(190_000);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await harness.emit('agent_settled');
      expect(harness.generationRequests).toHaveLength(attempt);
      expect(harness.generationRequests[attempt - 1]?.instructions).toContain('checkpoint pass 1');
      await harness.finishLatest('Incomplete checkpoint.');
      harness.appendAssistant(`The parent branch advanced ${attempt}.`);
    }

    expect(harness.notify).toHaveBeenCalledWith(
      'Doom autocompact summarization pass 1 returned an incomplete checkpoint 3 times and was abandoned.',
      'error',
    );
    expect(harness.telemetry.recordError).toHaveBeenCalledWith(
      AUTOCOMPACT_EVENT.checkpointInvalid,
      expect.any(Error),
      expect.objectContaining({ 'autocompact.checkpoint.attempts': 3, 'autocompact.checkpoint.exhausted': true }),
    );
    expect(
      harness.entries.findLast((entry) => entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE),
    ).toMatchObject({ data: { exhaustedPasses: [1], invalidAttempts: 0, checkpointQueue: [2, 3] } });

    // The abandoned rung is skipped while the rest of the ladder still runs.
    await harness.emit('agent_settled');
    expect(harness.generationRequests).toHaveLength(4);
    expect(harness.generationRequests[3]?.instructions).toContain('checkpoint pass 2');
  });

  it('abandons a pass whose summarizer keeps throwing and caps the failure telemetry', async () => {
    const harness = createHarness();
    harness.appendAssistant('Large parent transcript.');
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(190_000);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await harness.emit('agent_settled');
      expect(harness.generationRequests).toHaveLength(attempt);
      expect(harness.generationRequests[attempt - 1]?.instructions).toContain('checkpoint pass 1');
      await harness.finishLatest(undefined, true);
      harness.appendAssistant(`The parent branch advanced ${attempt}.`);
    }

    expect(harness.notify).toHaveBeenCalledWith(
      'Doom autocompact summarization pass 1 failed 3 times and was abandoned: summarizer unavailable',
      'error',
    );
    expect(
      harness.entries.findLast((entry) => entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE),
    ).toMatchObject({ data: { exhaustedPasses: [1], invalidAttempts: 0, checkpointQueue: [2, 3] } });

    // The abandoned rung is skipped while the rest of the ladder still runs.
    await harness.emit('agent_settled');
    expect(harness.generationRequests).toHaveLength(4);
    expect(harness.generationRequests[3]?.instructions).toContain('checkpoint pass 2');

    const pass1Failures = vi
      .mocked(harness.telemetry.recordError)
      .mock.calls.filter(
        ([event, , attributes]) =>
          event === AUTOCOMPACT_EVENT.checkpointFailed && attributes?.['autocompact.pass'] === 1,
      );
    expect(pass1Failures).toHaveLength(3);
  });

  it('reports a configuration load failure to telemetry exactly once', async () => {
    const harness = createHarness();
    harness.appendAssistant('Large parent transcript.');
    await harness.emit('session_start', { reason: 'startup' });
    loadDoomConfig.mockImplementation(() => {
      throw new Error('malformed autocompact configuration');
    });
    harness.setUsage(190_000);

    await harness.emit('agent_settled');
    harness.appendAssistant('The parent branch advanced.');
    await harness.emit('agent_settled');

    const configWarnings = vi
      .mocked(harness.telemetry.recordWarning)
      .mock.calls.filter(([event]) => event === AUTOCOMPACT_EVENT.configurationLoadFailed);
    expect(configWarnings).toHaveLength(1);
    expect(configWarnings[0]?.[1]).toBeInstanceOf(Error);
  });

  it('clears abandoned passes once the context is compacted', async () => {
    const harness = createHarness();
    harness.appendAssistant('Large parent transcript.');
    const state = createInitialState();
    state.pass = 2;
    state.exhaustedPasses = [1];
    state.invalidAttempts = 2;
    harness.appendState(state);
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(150_000);
    await harness.emit('agent_settled');
    await harness.finishLatest(COMPACT_CHECKPOINT);

    expect(
      harness.entries.findLast((entry) => entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE),
    ).toMatchObject({ data: { cycle: 2, pass: 1, exhaustedPasses: [], invalidAttempts: 0 } });
  });

  it('restores logical context after reload and tree navigation without hiding branch entries', async () => {
    const harness = createHarness();
    const archivedId = harness.appendAssistant('Visible archived message.');
    harness.appendCustomMessage(CONTEXT_MESSAGE_TYPE, STRUCTURED_CHECKPOINT, {
      readFiles: [],
      modifiedFiles: [],
      retainedMessages: [],
      doomAutocompact: {
        version: 2,
        cycle: 4,
        pass: 3,
        requestId: 'restored-request',
        snapshotLeafId: archivedId,
        tokensBefore: 180_000,
      },
    });
    harness.appendCustomMessage(
      RUNTIME_STATE_MESSAGE_TYPE,
      '<compaction-runtime-state>restored runtime</compaction-runtime-state>',
      { version: 1, tasks: [], teamAvailable: true, teamMembers: [] },
    );

    await harness.emit('session_start', { reason: 'reload' });
    const afterReload = await harness.contextProjection();
    await harness.emit('session_tree', { newLeafId: harness.entries.at(-1)?.id, oldLeafId: archivedId });
    const afterTree = await harness.contextProjection();

    expect(afterReload?.messages?.[0]?.role).toBe('compactionSummary');
    expect(afterTree?.messages?.[0]?.role).toBe('compactionSummary');
    expect(JSON.stringify(afterReload?.messages)).toContain('restored runtime');
    expect(JSON.stringify(afterTree?.messages)).toContain('restored runtime');
    expect(buildContextEntries(harness.entries, harness.entries.at(-1)?.id ?? null).map((entry) => entry.id)).toContain(
      archivedId,
    );
  });

  it('fails open and records one error for a malformed logical context marker', async () => {
    const harness = createHarness();
    harness.appendAssistant('Visible message.');
    harness.appendCustomMessage(CONTEXT_MESSAGE_TYPE, STRUCTURED_CHECKPOINT, {});

    const first = await harness.contextProjection();
    const second = await harness.contextProjection();

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(harness.telemetry.recordError).toHaveBeenCalledTimes(1);
    expect(harness.telemetry.recordError).toHaveBeenCalledWith(
      AUTOCOMPACT_EVENT.contextMarkerInvalid,
      expect.any(Error),
      expect.objectContaining({ 'pi.session.id': 'session-1' }),
    );
  });

  it('starts summarization during an active parent turn', async () => {
    const harness = createHarness();
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(100_000);
    harness.setPendingMessages(true);
    await harness.emit('agent_settled');
    expect(harness.generationRequests).toHaveLength(0);

    harness.setPendingMessages(false);
    harness.setIdle(false);
    await harness.emit('turn_end');
    expect(harness.generationRequests).toHaveLength(1);
  });

  it('commits a ready checkpoint at the next turn boundary during an active run', async () => {
    const harness = createHarness();
    harness.appendAssistant('Parent transcript before summarization.');
    const state = createInitialState();
    state.pass = 2;
    harness.appendState(state);
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(150_000);
    harness.setIdle(false);
    await harness.emit('turn_end', { toolResults: [] });
    expect(harness.generationRequests).toHaveLength(1);

    await harness.finishLatest(COMPACT_CHECKPOINT);
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();

    harness.appendAssistant('Tool work continued while the summary was pending.');
    await harness.emit('turn_end', { toolResults: [{ role: 'toolResult' }] });

    expect(harness.entries).toContainEqual(
      expect.objectContaining({ type: 'custom_message', customType: CONTEXT_MESSAGE_TYPE }),
    );
    expect(harness.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(harness.labels).toHaveLength(0);
    expect(harness.telemetry.recordEvent).toHaveBeenCalledWith(
      AUTOCOMPACT_EVENT.contextCommitted,
      expect.objectContaining({ 'autocompact.pass': 2, 'autocompact.apply_mode': 'turn_end' }),
    );
    expect(
      harness.entries.findLast((entry) => entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE),
    ).toMatchObject({ data: { cycle: 2, pass: 1, phase: 'waiting', checkpointQueue: [], baselinePending: true } });
  });

  it('defers the mid-run apply when the turn is final or user messages are pending', async () => {
    const harness = createHarness();
    harness.appendAssistant('Parent transcript before summarization.');
    const state = createInitialState();
    state.pass = 2;
    harness.appendState(state);
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(150_000);
    harness.setIdle(false);
    await harness.emit('turn_end', { toolResults: [] });
    await harness.finishLatest(COMPACT_CHECKPOINT);

    await harness.emit('turn_end', { toolResults: [] });
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();

    harness.setPendingMessages(true);
    await harness.emit('turn_end', { toolResults: [{ role: 'toolResult' }] });
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();

    harness.setPendingMessages(false);
    harness.setIdle(true);
    await harness.emit('agent_settled');

    const marker = harness.entries.find(
      (entry) => entry.type === 'custom_message' && entry.customType === CONTEXT_MESSAGE_TYPE,
    );
    expect(harness.labels).toContainEqual({ entryId: marker?.id, label: 'autocompact:c1:p2' });
    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Asynchronous compaction completed.') }),
      { triggerTurn: true, deliverAs: 'steer' },
    );
    expect(harness.telemetry.recordEvent).toHaveBeenCalledWith(
      AUTOCOMPACT_EVENT.contextCommitted,
      expect.objectContaining({ 'autocompact.apply_mode': 'idle' }),
    );
  });

  it('stages a mid-run pass 1 checkpoint without steering the agent and defers escalation', async () => {
    const harness = createHarness();
    harness.appendAssistant('Parent transcript.');
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(100_000);
    harness.setIdle(false);
    await harness.emit('turn_end', { toolResults: [{ role: 'toolResult' }] });
    expect(harness.generationRequests).toHaveLength(1);

    await harness.finishLatest(STRUCTURED_CHECKPOINT.replace('Checkpoint generated.', 'Stage 1 generated.'));
    await harness.emit('turn_end', { toolResults: [{ role: 'toolResult' }] });

    // Mid-run staging must not reach the agent: a checkpoint delivered as a message reads
    // like a user instruction and stops the run while work is still pending.
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
    expect(harness.entries).toContainEqual(
      expect.objectContaining({ type: 'custom', customType: CHECKPOINT_MESSAGE_TYPE }),
    );
    expect(JSON.stringify(buildSessionContext(harness.entries).messages)).not.toContain('Stage 1 generated.');
    expect(harness.generationRequests).toHaveLength(1);

    harness.appendAssistant('Work after the staged checkpoint.');
    harness.setUsage(150_000);
    await harness.emit('turn_end', { toolResults: [{ role: 'toolResult' }] });

    expect(harness.generationRequests).toHaveLength(2);
    expect(harness.generationRequests[1]?.instructions).toContain('checkpoint pass 2');
    expect(harness.generationRequests[1]?.previousCheckpoint).toContain('Stage 1 generated.');
  });

  it('defers the baseline capture until an assistant responds after the committed marker', async () => {
    const harness = createHarness();
    harness.appendAssistant('Parent transcript.');
    const state = createInitialState();
    state.pass = 2;
    harness.appendState(state);
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(150_000);
    await harness.emit('agent_settled');
    await harness.finishLatest(COMPACT_CHECKPOINT);

    harness.setUsage(319_395);
    await harness.emit('agent_settled');
    expect(harness.notify).not.toHaveBeenCalledWith(
      expect.stringContaining('baseline captured at 319395'),
      expect.anything(),
    );
    expect(
      harness.entries.findLast((entry) => entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE),
    ).toMatchObject({ data: { checkpointQueue: [], baselinePending: true } });

    harness.appendAssistant('First response measured against the projected context.');
    harness.setUsage(30_000);
    await harness.emit('agent_settled');

    expect(harness.notify).toHaveBeenCalledWith('Doom autocompact baseline captured at 30000 tokens.', 'info');
    expect(
      harness.entries.findLast((entry) => entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE),
    ).toMatchObject({ data: { baselineTokens: 30_000, baselinePending: false, checkpointQueue: [] } });
  });

  it('recovers the baseline from real usage when the committed marker is lost', async () => {
    const harness = createHarness();
    harness.appendAssistant('Parent transcript that was never compacted.');
    const state = createInitialState();
    state.baselinePending = true;
    harness.appendState(state);
    harness.setUsage(150_000);
    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.notify).toHaveBeenCalledWith('Doom autocompact baseline captured at 150000 tokens.', 'info');
  });

  it('aborts in-flight summarization whenever the session generation is replaced', async () => {
    const harness = createHarness();
    harness.appendAssistant('Parent transcript.');
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(190_000);
    await harness.emit('agent_settled');
    const signal = harness.generationRequests[0]?.signal;
    expect(signal?.aborted).toBe(false);

    // The selected branch can already contain a clean waiting state. Session replacement
    // must still dispose the worker owned by the previous generation before restore returns.
    harness.appendState(createInitialState());
    await harness.emit('session_tree', { newLeafId: harness.entries.at(-1)?.id });
    expect(signal?.aborted).toBe(true);
    await harness.finishLatest(STRUCTURED_CHECKPOINT);
  });

  it('reports compaction progress in the status bar from start to finish', async () => {
    const harness = createHarness();
    harness.appendAssistant('Parent transcript.');
    const state = createInitialState();
    state.pass = 2;
    harness.appendState(state);
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(150_000);
    await harness.emit('agent_settled');

    expect(harness.setStatus).toHaveBeenLastCalledWith('doom-autocompact', 'Compacting pass 2 (summarizing)…');

    await harness.finishLatest(COMPACT_CHECKPOINT);

    expect(harness.setStatus).toHaveBeenLastCalledWith('doom-autocompact', undefined);
  });

  it('cancels Pi threshold compaction only while the checkpoint machinery is active', async () => {
    const harness = createHarness();
    await harness.emit('session_start', { reason: 'startup' });

    expect(
      await harness.emit(
        'session_before_compact',
        beforeCompactEvent(harness, 'threshold') as unknown as Record<string, unknown>,
      ),
    ).toBeUndefined();

    harness.setUsage(190_000);
    await harness.emit('agent_settled');
    expect(harness.generationRequests).toHaveLength(1);

    expect(
      await harness.emit(
        'session_before_compact',
        beforeCompactEvent(harness, 'threshold') as unknown as Record<string, unknown>,
      ),
    ).toEqual({ cancel: true });
    expect(
      await harness.emit(
        'session_before_compact',
        beforeCompactEvent(harness, 'manual') as unknown as Record<string, unknown>,
      ),
    ).toBeUndefined();
    expect(
      await harness.emit(
        'session_before_compact',
        beforeCompactEvent(harness, 'overflow') as unknown as Record<string, unknown>,
      ),
    ).toBeUndefined();
  });

  it.each(NATIVE_COMPACTION_REASONS)('preserves one runtime snapshot after %s native compaction', async (reason) => {
    const harness = createHarness();
    await harness.emit('session_start', { reason: 'startup' });
    const entry = compactionEntry(`${reason}-compact`);
    harness.appendCompaction(entry.id);

    await harness.emit('session_compact', {
      compactionEntry: entry,
      fromExtension: false,
      reason,
      willRetry: reason === 'overflow',
    });

    expect(
      harness.entries.filter(
        (candidate) => candidate.type === 'custom_message' && candidate.customType === RUNTIME_STATE_MESSAGE_TYPE,
      ),
    ).toHaveLength(1);
    expect(harness.entries.at(-1)).toMatchObject({
      type: 'custom',
      customType: STATE_CUSTOM_TYPE,
    });
    const runtimeIndex = harness.entries.findIndex(
      (candidate) => candidate.type === 'custom_message' && candidate.customType === RUNTIME_STATE_MESSAGE_TYPE,
    );
    const compactionIndex = harness.entries.findIndex((candidate) => candidate.id === entry.id);
    expect(runtimeIndex).toBeGreaterThan(compactionIndex);
  });

  it('aborts an in-flight summarization on shutdown', async () => {
    const harness = createHarness();
    await harness.emit('session_start', { reason: 'startup' });
    harness.setUsage(190_000);
    await harness.emit('agent_settled');
    const signal = harness.generationRequests[0]?.signal;
    expect(signal?.aborted).toBe(false);

    const shutdown = Promise.resolve(harness.emit('session_shutdown'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal?.aborted).toBe(true);
    await harness.finishLatest(STRUCTURED_CHECKPOINT);
    await shutdown;
    expect(harness.telemetry.shutdown).toHaveBeenCalledOnce();
    await harness.emit('session_start', { reason: 'stale' });
    expect(harness.generationRequests).toHaveLength(1);
  });
});
