import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetHarnessStore } from '@agimon-ai/doompi-config';
import type { LeaderContribution } from '@agimon-ai/doompi-extension-contracts/leader';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  MINOR_MODE_TOOL_NAME,
  type MinorModeCatalogService,
  type MinorModeOwnerDefinition,
  type MinorModeOwnerHandle,
  type MinorModeState,
} from '@agimon-ai/doompi-extension-contracts/mode';
import {
  DOOM_NARRATION_SERVICE,
  DOOM_VOICE_AUTO_MODE_ID,
  DOOM_VOICE_SOURCE,
  type DoomNarrationService,
  type NarrationRequest,
} from '@agimon-ai/doompi-extension-contracts/narration';
import {
  DOOM_SUBAGENT_POLICY_SERVICE,
  type DoomSubagentPolicyService,
  type SubagentPolicy,
  type SubagentPolicyHandle,
} from '@agimon-ai/doompi-extension-contracts/subagent-policy';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import {
  createDoomVoiceToolsService,
  DOOM_VOICE_TOOLS_SERVICE,
  type DoomVoiceToolsService,
  VOICE_MODE_TOOL_NAMES,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { PlanningModeConfig, PlanningThinkingLevel } from '../src/exports/config';
import type { PlanPointerRecord } from '../src/types/planApi.ts';
import type { PlanPointerPort } from '../src/types/planPointer.ts';
import type { FablePlanBroker, FablePlanPacket } from '../src/exports/fableFlow';
import {
  configurePlanningSubagentInput,
  configurePlanningTaskInput,
  constrainSubagentInput,
  isBlockedSubagentManagementAction,
  loadPlanningModeConfig,
  type PlanModeExtensionOptions,
  parseDebugEvidencePacket,
  parsePersistedPlanState,
  planModeExtension,
  planModeTools,
  planningSubagentModel,
  planSessionIdentifier,
  planTitleSlug,
  visiblePlanForToolCall,
  WRITE_PLAN_TIMEOUT_MS,
} from '../src/exports/planMode';

let testPlansDirectory: string | undefined;
const PLAN_TRIGGER_ATTRIBUTE = 'plan.trigger';
const UNRELATED_TOOL_NAME = 'foreign_extension_tool';

type PlanLeaderAction = 'plan.normal' | 'plan.debug' | 'plan.fable' | 'plan.exit';

interface FixtureModel {
  provider: string;
  id: string;
}

interface RecordedTelemetry {
  level: 'error' | 'warn' | 'info';
  event: string;
  error?: unknown;
  attributes?: Record<string, string | number | boolean>;
}

interface FixtureOptions extends PlanModeExtensionOptions {
  askUserEnabled?: boolean;
  autonomousVoice?: boolean;
  narrationError?: Error;
  voiceModeActivation?: 'active' | 'inactive';
  voiceModeId?: string;
  voiceModeSource?: string;
}

interface HarnessExtensionFixture {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  activeTools: () => string[];
  currentModel: () => FixtureModel;
  thinkingLevel: () => PlanningThinkingLevel;
  appendedEntries: Array<{ customType: string; data: unknown }>;
  narrationRequests: NarrationRequest[];
  voiceTools: DoomVoiceToolsService<ExtensionContext>;
  latestSubagentPolicy(): SubagentPolicy | undefined;
  subagentPolicyDisposals: string[];
  leaderContributions: LeaderContribution[];
  leaderDispose: ReturnType<typeof vi.fn>;
  telemetryRecords: RecordedTelemetry[];
  telemetryShutdown: ReturnType<typeof vi.fn>;
  registeredCommandNames: () => string[];
  latestModeItem(): { label?: string; detail?: string; color?: string } | undefined;
  latestModeState(): MinorModeState | undefined;
  registeredTool(name: string): { parameters?: unknown } | undefined;
  invokeLeaderAction(action: PlanLeaderAction): Promise<void>;
  invokeModeAction(action: string, argumentsValue?: Record<string, string>): Promise<unknown>;
  recordDebugEvidence(value: unknown): Promise<unknown>;
  runFablePlan(value: FablePlanPacket, signal?: AbortSignal): Promise<unknown>;
  completePlan(decision?: 'exit' | 'continue'): Promise<unknown>;
  writePlan(content: string, signal?: AbortSignal): Promise<unknown>;
  writePlanWithoutDisplay(signal?: AbortSignal): Promise<unknown>;
  handler(name: string): (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
  notifications: ReturnType<typeof vi.fn>;
  planUpdates: ReturnType<typeof vi.fn>;
  selections: ReturnType<typeof vi.fn>;
  statuses: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setThinkingLevel: ReturnType<typeof vi.fn>;
  widgets: ReturnType<typeof vi.fn>;
}

function createExtensionFixture(
  entries: unknown[] = [],
  selection = 'Exit plan mode and start implementation',
  hasUI = true,
  sessionId = 'plan-mode-test-session',
  planningConfig: PlanningModeConfig | (() => PlanningModeConfig | undefined) = {},
  extensionOptions: FixtureOptions = {},
): HarnessExtensionFixture {
  const registeredCommands: string[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>();
  const registeredTools = new Map<string, { parameters?: unknown; execute(...args: unknown[]): Promise<unknown> }>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const narrationRequests: NarrationRequest[] = [];
  const subagentPolicies: SubagentPolicy[] = [];
  const subagentPolicyDisposals: string[] = [];
  const leaderContributions: LeaderContribution[] = [];
  const leaderDispose = vi.fn();
  const notifications = vi.fn();
  const planUpdates = vi.fn();
  const selections = vi.fn().mockResolvedValue(selection);
  const statuses = vi.fn();
  const widgets = vi.fn();
  const models: FixtureModel[] = [
    { provider: 'openai-codex', id: 'original' },
    { provider: 'openai-codex', id: 'alternate' },
    { provider: 'anthropic', id: 'planner' },
  ];
  let currentModel = models[0]!;
  let thinkingLevel: PlanningThinkingLevel = 'low';
  const setModel = vi.fn(async (model: FixtureModel) => {
    currentModel = model;
    return true;
  });
  const setThinkingLevel = vi.fn((level: PlanningThinkingLevel) => {
    thinkingLevel = level;
  });
  const askUserTools = extensionOptions.askUserEnabled === false ? [] : ['ask_user_question'];
  let activeTools = ['read', 'bash', 'edit', 'write', 'subagent', ...askUserTools, 'mcp'];
  let toolCallSequence = 0;

  const piShape = {
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () =>
      [
        'read',
        'bash',
        'edit',
        'write',
        'grep',
        'find',
        'ls',
        'subagent',
        'task',
        ...askUserTools,
        'mcp',
        MINOR_MODE_TOOL_NAME,
        ...VOICE_MODE_TOOL_NAMES,
        UNRELATED_TOOL_NAME,
        ...registeredTools.keys(),
      ].map((name) => ({ name })),
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel,
    setModel,
    registerCommand(name: string, _command: unknown) {
      registeredCommands.push(name);
    },
    registerTool(tool: { name: string; parameters?: unknown; execute(...args: unknown[]): Promise<unknown> }) {
      registeredTools.set(tool.name, tool);
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    on(name: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) {
      handlers.set(name, [...(handlers.get(name) ?? []), callback]);
    },
  };
  const ctxShape = {
    cwd: '/work',
    hasUI,
    get model() {
      return currentModel;
    },
    modelRegistry: {
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => models,
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => process.env.PI_SESSION_FILE,
      getEntries: () => entries,
      getBranch: () => entries,
    },
    ui: {
      notify: notifications,
      select: selections,
      setStatus: statuses,
      setWidget: widgets,
      theme: { fg: (_color: string, text: string) => text },
    },
  };
  const pi = piShape as unknown as ExtensionAPI;
  const ctx = ctxShape as unknown as ExtensionContext;
  const configuredProvider = typeof planningConfig === 'function' ? planningConfig : () => planningConfig;
  const planningConfigProvider = (): PlanningModeConfig | undefined => {
    const configured = configuredProvider();
    return testPlansDirectory && !configured?.plansDirectory
      ? { ...configured, plansDirectory: testPlansDirectory }
      : configured;
  };
  const telemetryRecords: RecordedTelemetry[] = [];
  const telemetryShutdown = vi.fn(async () => undefined);
  const capture =
    (level: RecordedTelemetry['level']) =>
    async (event: string, error: unknown, attributes?: RecordedTelemetry['attributes']) => {
      telemetryRecords.push({ level, event, error, attributes });
    };
  const cordis = new Context();
  let leaderActions: Parameters<DoomUiHubService['registerLeaderActions']>[0] | undefined;
  const uiHub = {
    registerConfig: vi.fn(() => ({ dispose: vi.fn(), update: vi.fn() })),
    registerFooter: vi.fn(),
    registerLeader(contribution: LeaderContribution) {
      leaderContributions.push(structuredClone(contribution));
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          leaderDispose();
        },
        update(bindings: LeaderContribution['bindings']) {
          if (!disposed) leaderContributions.push({ source: contribution.source, bindings: structuredClone(bindings) });
        },
      };
    },
    registerLeaderActions(options: Parameters<DoomUiHubService['registerLeaderActions']>[0]) {
      leaderActions = options;
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        if (leaderActions === options) leaderActions = undefined;
      };
    },
  } as unknown as DoomUiHubService;
  let activeMode:
    | {
        readonly definition: MinorModeOwnerDefinition<ExtensionContext>;
        readonly handle: MinorModeOwnerHandle;
        state: MinorModeState;
      }
    | undefined;
  const voiceModeRecord = {
    descriptor: {
      source: extensionOptions.voiceModeSource ?? DOOM_VOICE_SOURCE,
      id: extensionOptions.voiceModeId ?? DOOM_VOICE_AUTO_MODE_ID,
      label: 'Voice',
      description: 'Autonomous voice capture.',
      order: 30,
      actions: [],
    },
    state: {
      activation: extensionOptions.voiceModeActivation ?? ('active' as const),
      condition: 'ready' as const,
      actions: [],
    },
    ownerGeneration: 'voice-owner-1',
    registrationId: 'voice-registration-1',
    stateRevision: 1,
  };
  const modeCatalog = {
    generation: 'catalog-1',
    dispose: vi.fn(),
    getSnapshot: () => ({
      hostGeneration: 'catalog-1',
      revision: 1,
      modes: extensionOptions.autonomousVoice ? [voiceModeRecord] : [],
    }),
    invoke: vi.fn(async () => {
      throw new Error('Mode invocation is not used by the Plan fixture.');
    }),
    list: () => (extensionOptions.autonomousVoice ? [voiceModeRecord] : []),
    registerOwner(definition: MinorModeOwnerDefinition<ExtensionContext>): MinorModeOwnerHandle {
      let state = structuredClone(definition.initialState);
      let disposed = false;
      const handle: MinorModeOwnerHandle = {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (activeMode?.handle === handle) activeMode = undefined;
        },
        getState: () => structuredClone(state),
        publish(next) {
          if (disposed) return;
          state = structuredClone(next);
          if (activeMode?.handle === handle) activeMode.state = structuredClone(next);
        },
      };
      activeMode = { definition, handle, state: structuredClone(state) };
      return handle;
    },
    subscribe: () => () => undefined,
  } as unknown as MinorModeCatalogService;
  const voiceTools = createDoomVoiceToolsService<ExtensionContext>(`plan-voice-tools:${sessionId}`);
  const narrationService: DoomNarrationService = {
    generation: `plan-narration:${sessionId}`,
    request: vi.fn((request: NarrationRequest) => {
      narrationRequests.push(structuredClone(request));
      if (extensionOptions.narrationError) throw extensionOptions.narrationError;
    }),
  };
  let nextPolicyGeneration = 0;
  const subagentPolicyService: DoomSubagentPolicyService = {
    generation: `plan-policy-service:${sessionId}`,
    register(initialPolicy): SubagentPolicyHandle {
      const owner = initialPolicy.owner;
      const generation = `plan-policy:${++nextPolicyGeneration}`;
      let disposed = false;
      subagentPolicies.push(structuredClone(initialPolicy));
      return {
        owner,
        generation,
        update(policy) {
          if (disposed) throw new Error('Cannot update a disposed subagent policy test handle.');
          if (policy.owner !== owner) throw new Error('Cannot change a subagent policy owner.');
          subagentPolicies.push(structuredClone(policy));
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          subagentPolicyDisposals.push(owner);
        },
      };
    },
  };
  cordis.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, modeCatalog);
  cordis.provide(DOOM_NARRATION_SERVICE, narrationService);
  cordis.provide(DOOM_SUBAGENT_POLICY_SERVICE, subagentPolicyService);
  cordis.provide(DOOM_UI_HUB_SERVICE, uiHub);
  cordis.provide(DOOM_VOICE_TOOLS_SERVICE, voiceTools);
  cordis.effect(() => () => voiceTools.dispose(), 'plan-test-voice-tools');
  planModeExtension(
    cordis,
    pi,
    planningConfigProvider,
    {
      recordError: capture('error'),
      recordWarning: capture('warn'),
      recordEvent: async (event, attributes) => {
        telemetryRecords.push({ level: 'info', event, attributes });
      },
      flush: vi.fn(async () => undefined),
      shutdown: telemetryShutdown,
    },
    {
      fableBroker: extensionOptions.fableBroker,
      debugDiagnosticTools: extensionOptions.debugDiagnosticTools,
      doomIntegrations: extensionOptions.doomIntegrations,
      planPointers: extensionOptions.planPointers,
    },
  );
  pi.on('session_shutdown', () => cordis.fiber.dispose());

  return {
    pi,
    ctx,
    activeTools: () => activeTools,
    currentModel: () => currentModel,
    thinkingLevel: () => thinkingLevel,
    appendedEntries,
    narrationRequests,
    voiceTools,
    latestSubagentPolicy: () => subagentPolicies.at(-1),
    subagentPolicyDisposals,
    leaderContributions,
    leaderDispose,
    telemetryRecords,
    telemetryShutdown,
    registeredCommandNames: () => [...registeredCommands],
    latestModeItem: () => {
      const mode = activeMode;
      if (!mode || mode.state.activation !== 'active') return undefined;
      return {
        label: mode.definition.descriptor.label,
        detail: mode.state.detail,
        color: mode.state.color,
      };
    },
    latestModeState: () => (activeMode ? structuredClone(activeMode.state) : undefined),
    registeredTool: (name) => registeredTools.get(name),
    invokeLeaderAction: async (action) => {
      const handler = leaderActions?.handlers[action];
      if (!handler) throw new Error(`Plan leader action '${action}' is unavailable.`);
      try {
        await handler(ctx);
      } catch (error) {
        leaderActions?.onError?.(error, action, ctx);
      }
    },
    invokeModeAction: async (action, argumentsValue = {}) => {
      const mode = activeMode;
      if (!mode) throw new Error('Plan minor mode is unavailable.');
      return mode.definition.handleAction(action, argumentsValue, {
        context: ctx,
        operationId: `plan-mode-test:${action}`,
        sessionKind: 'tui',
        signal: new AbortController().signal,
      });
    },
    recordDebugEvidence(value) {
      return registeredTools.get('record_debug_evidence')!.execute('debug-test', value, undefined, undefined, ctx);
    },
    runFablePlan(value, signal) {
      return registeredTools.get('run_fable_plan')!.execute('fable-test', value, signal, undefined, ctx);
    },
    completePlan(decision) {
      return registeredTools
        .get('complete_plan')!
        .execute('test-call', decision ? { decision } : {}, undefined, undefined, ctx);
    },
    writePlan(content, signal) {
      const toolCallId = `write-plan-${toolCallSequence++}`;
      entries.push({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: content },
            { type: 'toolCall', id: toolCallId, name: 'write_plan', arguments: {} },
          ],
        },
      });
      return registeredTools.get('write_plan')!.execute(toolCallId, {}, signal, planUpdates, ctx);
    },
    writePlanWithoutDisplay(signal) {
      const toolCallId = `write-plan-${toolCallSequence++}`;
      entries.push({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: toolCallId, name: 'write_plan', arguments: {} }],
        },
      });
      return registeredTools.get('write_plan')!.execute(toolCallId, {}, signal, planUpdates, ctx);
    },
    handler(name) {
      const callbacks = handlers.get(name);
      if (!callbacks?.length) throw new Error(`Missing handler: ${name}`);
      return async (event, context) => {
        let result: unknown;
        for (const callback of callbacks) {
          const callbackResult = await callback(event, context);
          if (callbackResult !== undefined) result = callbackResult;
        }
        return result;
      };
    },
    notifications,
    planUpdates,
    selections,
    statuses,
    setModel,
    setThinkingLevel,
    widgets,
  };
}

async function withPiSession<T>(run: (sessionDirectory: string) => Promise<T>): Promise<T> {
  const sessionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-harness-plan-session-'));
  const previousSessionFile = process.env.PI_SESSION_FILE;
  const previousPlansDirectory = testPlansDirectory;
  process.env.PI_SESSION_FILE = path.join(sessionDirectory, 'session.jsonl');
  testPlansDirectory = path.join(sessionDirectory, 'plans');
  try {
    return await run(sessionDirectory);
  } finally {
    if (previousSessionFile === undefined) delete process.env.PI_SESSION_FILE;
    else process.env.PI_SESSION_FILE = previousSessionFile;
    testPlansDirectory = previousPlansDirectory;
    fs.rmSync(sessionDirectory, { recursive: true, force: true });
  }
}

function activePlanId(fixture: HarnessExtensionFixture): string {
  const value = [...fixture.appendedEntries]
    .reverse()
    .find(({ customType }) => customType === 'agent-harness-plan-mode')?.data as { planId?: string } | undefined;
  if (!value?.planId) throw new Error('Expected an active plan id.');
  return value.planId;
}

function expectedPlanPath(sessionDirectory: string, title: string, fixture: HarnessExtensionFixture): string {
  return path.join(sessionDirectory, 'plans', `${title}--${activePlanId(fixture)}.md`);
}

describe('plan mode entry', () => {
  it('removes every auto-activated Plan tool from a fresh dormant session', async () => {
    const fixture = createExtensionFixture();
    const planTools = ['record_debug_evidence', 'run_fable_plan', 'write_plan', 'complete_plan'];

    expect(fixture.activeTools()).toEqual(expect.arrayContaining(planTools));
    await fixture.handler('session_start')({}, fixture.ctx);
    for (const name of planTools) expect(fixture.activeTools()).not.toContain(name);
  });

  it('restores an active mode once and fences callbacks after repeated shutdown', async () => {
    const fixture = createExtensionFixture();
    await fixture.handler('session_start')({}, fixture.ctx);
    await fixture.invokeLeaderAction('plan.normal');
    expect(fixture.activeTools()).not.toContain('edit');

    await Promise.all([
      fixture.handler('session_shutdown')({}, fixture.ctx),
      fixture.handler('session_shutdown')({}, fixture.ctx),
    ]);

    expect(fixture.activeTools()).toContain('edit');
    expect(fixture.telemetryShutdown).toHaveBeenCalledOnce();
    await expect(fixture.handler('session_start')({}, fixture.ctx)).resolves.toBeUndefined();
    await expect(fixture.handler('tool_call')({ toolName: 'edit', input: {} }, fixture.ctx)).resolves.toBeUndefined();
    await expect(
      fixture.handler('before_agent_start')({ systemPrompt: 'base prompt' }, fixture.ctx),
    ).resolves.toBeUndefined();
    await expect(fixture.handler('context')({ messages: [{ role: 'user' }] }, fixture.ctx)).resolves.toBeUndefined();
    await expect(fixture.recordDebugEvidence({ issue: 'stale' })).rejects.toThrow('Plan runtime is disposed or stale.');
  });

  it('publishes the three entry flavors and disposes its contribution', async () => {
    const fixture = createExtensionFixture();
    await fixture.handler('session_start')({}, fixture.ctx);

    expect(fixture.leaderContributions[0]).toMatchObject({
      source: '@agimon-ai/doompi-plan',
      bindings: [
        { id: 'plan.normal', action: { name: 'plan.normal' } },
        { id: 'plan.debug', action: { name: 'plan.debug' } },
        { id: 'plan.fable', action: { name: 'plan.fable' } },
      ],
      // `d` and `f` are flavors of the same mode, so they keep their own keys.
    });

    expect(fixture.leaderContributions[0]?.bindings.every((binding) => 'action' in binding)).toBe(true);

    await fixture.handler('session_shutdown')({}, fixture.ctx);
    expect(fixture.leaderDispose).toHaveBeenCalled();
  });

  // `e` carries the mode in both directions: only one of enter and exit ever does
  // anything, and a menu printing both makes the reader check the mode line to
  // find out which.
  it('flips the e entry between entering and leaving the mode', async () => {
    const fixture = createExtensionFixture();
    await fixture.handler('session_start')({}, fixture.ctx);

    const latestBindings = (): string[] =>
      (fixture.leaderContributions.at(-1)?.bindings ?? []).map((binding) => binding.id);
    const entryOn = (): unknown =>
      (fixture.leaderContributions.at(-1)?.bindings ?? []).find((binding) =>
        binding.path.some((segment) => segment.key === 'e'),
      );

    expect(latestBindings()).not.toContain('plan.exit');
    expect(entryOn()).toMatchObject({
      id: 'plan.normal',
      path: [{ key: 'p' }, { key: 'e', label: 'enter' }],
    });

    await fixture.invokeLeaderAction('plan.normal');
    expect(latestBindings()).toContain('plan.exit');
    expect(latestBindings()).not.toContain('plan.normal');
    // The exit tone is what paints the badge apart from the blue enter badge.
    expect(entryOn()).toMatchObject({
      id: 'plan.exit',
      path: [{ key: 'p' }, { key: 'e', label: 'exit', tone: 'exit' }],
    });

    await fixture.invokeLeaderAction('plan.exit');
    expect(latestBindings()).not.toContain('plan.exit');
    expect(latestBindings()).toContain('plan.normal');
  });

  it('handles all four leader actions with serialized idempotent flavor switching', async () => {
    const fixture = createExtensionFixture();
    await fixture.handler('session_start')({}, fixture.ctx);
    const initialSnapshot = {
      tools: fixture.activeTools(),
      model: fixture.currentModel(),
      thinking: fixture.thinkingLevel(),
    };

    await Promise.all([fixture.invokeLeaderAction('plan.normal'), fixture.invokeLeaderAction('plan.normal')]);
    expect(fixture.notifications).toHaveBeenCalledWith('Already in plan:normal.', 'info');

    await fixture.invokeLeaderAction('plan.debug');
    expect(fixture.activeTools()).toContain('read');
    expect(fixture.activeTools()).toContain('record_debug_evidence');

    await fixture.invokeLeaderAction('plan.fable');
    expect(fixture.activeTools()).toContain('run_fable_plan');

    const snapshots = fixture.appendedEntries
      .filter(({ customType }) => customType === 'agent-harness-plan-mode')
      .map(({ data }) => data as { originalSnapshot?: unknown })
      .filter(({ originalSnapshot }) => originalSnapshot !== undefined)
      .map(({ originalSnapshot }) => originalSnapshot);
    expect(snapshots).toEqual([
      {
        tools: initialSnapshot.tools,
        model: initialSnapshot.model,
        thinking: initialSnapshot.thinking,
      },
      {
        tools: initialSnapshot.tools,
        model: initialSnapshot.model,
        thinking: initialSnapshot.thinking,
      },
      {
        tools: initialSnapshot.tools,
        model: initialSnapshot.model,
        thinking: initialSnapshot.thinking,
      },
    ]);

    await fixture.invokeLeaderAction('plan.exit');
    expect(fixture.activeTools()).toEqual(initialSnapshot.tools);
    expect(fixture.currentModel()).toEqual(initialSnapshot.model);
    expect(fixture.thinkingLevel()).toBe(initialSnapshot.thinking);
  });

  it('restores an empty off-thinking snapshot transactionally after a model restore failure', async () => {
    const fixture = createExtensionFixture();
    fixture.pi.setActiveTools([]);
    fixture.pi.setThinkingLevel('off');
    await fixture.handler('session_start')({}, fixture.ctx);

    await fixture.invokeLeaderAction('plan.normal');
    expect(fixture.activeTools()).not.toEqual([]);

    fixture.setModel.mockImplementationOnce(async () => false);
    await fixture.invokeLeaderAction('plan.exit');
    expect(fixture.activeTools()).not.toEqual([]);
    expect(fixture.appendedEntries.at(-1)?.data).toMatchObject({ version: 2, activeFlavor: 'normal' });

    await fixture.invokeLeaderAction('plan.exit');
    expect(fixture.activeTools()).toEqual([]);
    expect(fixture.thinkingLevel()).toBe('off');
  });

  it('allows debug planning to explore, write, and complete without evidence', async () => {
    const fixture = createExtensionFixture();
    await fixture.handler('session_start')({}, fixture.ctx);
    await fixture.invokeLeaderAction('plan.debug');

    expect(fixture.activeTools()).toContain('read');
    expect(fixture.activeTools()).toContain('subagent');
    expect(fixture.activeTools()).toContain('write_plan');
    expect(fixture.activeTools()).toContain('record_debug_evidence');
    await expect(fixture.writePlan('# Debug plan')).resolves.toMatchObject({ details: { written: true } });
    await expect(fixture.completePlan()).resolves.toMatchObject({ details: { exited: true } });
  });

  it('validates sparse debug evidence and exposes diagnostic tools immediately', async () => {
    const validPacket = {
      issue: 'The action failed.',
      expectedBehavior: 'The action succeeds.',
      reproductionAttempt: 'Invoked the action once.',
      actualBehavior: 'The action returned an error.',
      logs: ['log line'],
      correlatedTraceEvidence: [],
      processOutput: ['process line'],
      browserConsoleEvidence: [],
      correlationIds: [],
      timestamps: ['2026-01-01T00:00:00.000Z'],
      verifiedFacts: ['The failure is reproducible.'],
      hypotheses: [],
      unavailableEvidence: ['correlatedTraceEvidence', 'browserConsoleEvidence', 'correlationIds'],
    };

    expect(parseDebugEvidencePacket(validPacket)).toEqual(validPacket);
    expect(parseDebugEvidencePacket({ issue: 'Only the reported issue is known.' })).toMatchObject({
      issue: 'Only the reported issue is known.',
      logs: [],
      verifiedFacts: [],
    });
    const invalidPackets: Array<[unknown, string]> = [
      [null, 'must be an object'],
      [{ ...validPacket, extra: true }, 'unsupported field'],
      [{ ...validPacket, issue: '' }, 'must not be empty'],
      [{ ...validPacket, expectedBehavior: 1 }, 'must be a string'],
      [{ ...validPacket, actualBehavior: 'x'.repeat(4_097) }, 'bounded debug evidence limit'],
      [{ ...validPacket, logs: 'not-a-list' }, 'bounded string array'],
      [{ ...validPacket, logs: Array.from({ length: 33 }, () => 'line') }, 'bounded string array'],
    ];
    for (const [packet, message] of invalidPackets) {
      expect(() => parseDebugEvidencePacket(packet)).toThrow(message);
    }

    const fixture = createExtensionFixture(
      [],
      undefined,
      true,
      'debug-diagnostics',
      {},
      {
        debugDiagnosticTools: ['mcp'],
      },
    );
    await fixture.handler('session_start')({}, fixture.ctx);
    await fixture.invokeLeaderAction('plan.debug');
    await expect(
      fixture.handler('tool_call')({ toolName: 'record_debug_evidence', input: validPacket }, fixture.ctx),
    ).resolves.toBeUndefined();
    await expect(fixture.handler('tool_call')({ toolName: 'mcp', input: {} }, fixture.ctx)).resolves.toBeUndefined();
    await expect(fixture.recordDebugEvidence({ ...validPacket, extra: true })).rejects.toThrow('unsupported field');
    expect(fixture.activeTools()).toContain('read');
    expect(fixture.activeTools()).toContain('record_debug_evidence');
    expect(fixture.activeTools()).toContain('mcp');
    expect(fixture.registeredTool('record_debug_evidence')?.parameters).toMatchObject({
      required: ['issue'],
      additionalProperties: false,
    });

    await fixture.recordDebugEvidence(validPacket);
    expect(fixture.activeTools()).toContain('mcp');
    const prompt = (await fixture.handler('before_agent_start')({ systemPrompt: 'base' }, fixture.ctx)) as {
      systemPrompt: string;
    };
    expect(prompt.systemPrompt).toContain('[PLAN MODE ACTIVE: DEBUG]');
    expect(prompt.systemPrompt).toContain('verifiedFacts: The failure is reproducible.');
  });

  it('runs Fable only through the fixed profile while keeping output untrusted', async () => {
    const start = vi.fn<FablePlanBroker['start']>(async (request) => ({
      operationId: request.operationId,
      status: 'completed',
      stage: 'completed',
      draft: '# Vendor draft',
      durationMs: 2,
    }));
    const broker: FablePlanBroker = { start, cancel: vi.fn() };
    const fixture = createExtensionFixture([], undefined, true, 'fable-plan', {}, { fableBroker: broker });
    const packet: FablePlanPacket = {
      goal: ['Replace slash planning'],
      constraints: ['Keep repository access read-only'],
      decisions: ['Use typed leader actions'],
      verifiedFindings: [
        { path: 'packages/minor/doompi-plan/src/planMode.ts', finding: 'The extension owns mode state.' },
      ],
      inferredFindings: [],
      unresolvedQuestions: [],
    };
    await fixture.handler('session_start')({}, fixture.ctx);

    await expect(fixture.runFablePlan(packet)).resolves.toMatchObject({ details: { started: false } });
    await fixture.invokeLeaderAction('plan.fable');
    await expect(
      fixture.handler('tool_call')({ toolName: 'run_fable_plan', input: packet }, fixture.ctx),
    ).resolves.toBeUndefined();
    const fableResult = await fixture.runFablePlan(packet);
    expect(fableResult).toMatchObject({
      content: [{ text: expect.stringContaining('Fable draft:\n# Vendor draft') }],
      details: { started: true, status: 'completed' },
    });
    expect(fableResult).not.toEqual(
      expect.objectContaining({
        content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Fable review:') })]),
      }),
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        requester: '@agimon-ai/doompi-plan',
        runtime: 'claude',
        model: 'fable',
        profile: 'claude/fable-plan-v1',
      }),
      expect.any(AbortSignal),
    );
    expect(fixture.latestSubagentPolicy()?.allowedExternalProfiles).toEqual(['claude/fable-plan-v1']);

    const prompt = (await fixture.handler('before_agent_start')({ systemPrompt: 'base' }, fixture.ctx)) as {
      systemPrompt: string;
    };
    expect(prompt.systemPrompt).toContain('[PLAN MODE ACTIVE: FABLE]');
    expect(prompt.systemPrompt).toContain('repository inspection access');
    expect(prompt.systemPrompt).toContain('untrusted text');
    expect(prompt.systemPrompt).not.toContain('separate fresh review');
  });

  it('fails closed when Fable has no local broker and restores an interrupted stage', async () => {
    const unavailable = createExtensionFixture();
    await unavailable.handler('session_start')({}, unavailable.ctx);
    await unavailable.invokeLeaderAction('plan.fable');
    await expect(
      unavailable.runFablePlan({
        goal: ['Plan'],
        constraints: [],
        decisions: [],
        verifiedFindings: [],
        inferredFindings: [],
        unresolvedQuestions: [],
      }),
    ).resolves.toMatchObject({ details: { started: false, errorCode: 'broker_unavailable' } });

    const restored = createExtensionFixture([
      {
        type: 'custom',
        customType: 'agent-harness-plan-mode',
        data: {
          version: 2,
          activeFlavor: 'fable',
          originalSnapshot: {
            tools: ['read', 'bash'],
            model: { provider: 'openai-codex', id: 'original' },
            thinking: 'low',
          },
          interruptedFableStage: 'review',
        },
      },
    ]);
    await restored.handler('session_start')({}, restored.ctx);
    expect(restored.latestModeItem()).toMatchObject({
      label: 'Plan',
      detail: 'fable · interrupted - read only',
    });
    const prompt = (await restored.handler('before_agent_start')({ systemPrompt: 'base' }, restored.ctx)) as {
      systemPrompt: string;
    };
    expect(prompt.systemPrompt).toContain('Current Fable stage: interrupted');
  });

  it('rejects malformed versioned and legacy persisted flavor state', () => {
    expect(
      parsePersistedPlanState({
        version: 2,
        activeFlavor: 'debug',
        originalSnapshot: {
          tools: [],
          model: { provider: 'openai-codex', id: 'original' },
          thinking: 'off',
        },
        planId: 'plan-1',
        interruptedFableStage: 'draft',
      }),
    ).toMatchObject({ activeFlavor: 'debug', planId: 'plan-1', interruptedFableStage: 'draft' });

    const invalidStates: unknown[] = [
      null,
      { version: 3 },
      { version: 2, activeFlavor: 'other' },
      { version: 2, originalSnapshot: null },
      { version: 2, originalSnapshot: { tools: 'read', thinking: 'low' } },
      { version: 2, originalSnapshot: { tools: [], thinking: 'invalid' } },
      { version: 2, originalSnapshot: { tools: [], thinking: 'low', model: {} } },
      { version: 2, planId: 1 },
      { version: 2, interruptedFableStage: 'unknown' },
      { enabled: 'yes' },
      { enabled: true, toolsBeforePlanMode: [1] },
      { enabled: true, modelBeforePlanMode: {} },
      { enabled: true, thinkingBeforePlanMode: 'invalid' },
      { enabled: true, planId: 1 },
    ];
    for (const state of invalidStates) expect(parsePersistedPlanState(state)).toBeUndefined();
  });

  it('does not register or mention a slash command for plan mode', async () => {
    const fixture = createExtensionFixture();
    await fixture.handler('session_start')({}, fixture.ctx);
    expect(fixture.registeredCommandNames()).toEqual([]);

    await fixture.invokeLeaderAction('plan.normal');
    const prompt = await fixture.handler('before_agent_start')({ systemPrompt: 'base prompt' }, fixture.ctx);
    expect(JSON.stringify(prompt)).not.toContain('Usage: /plan');

    const blocked = await fixture.handler('tool_call')({ toolName: 'unknown_tool', input: {} }, fixture.ctx);
    expect(JSON.stringify(blocked)).not.toContain('/plan');
  });

  it('keeps Bash, explicit read-only exploration, and subagent tools', () => {
    expect(
      planModeTools(
        ['read', 'bash', 'edit', 'write', 'subagent', 'ask_user_question', 'mcp'],
        [
          'read',
          'bash',
          'edit',
          'write',
          'grep',
          'find',
          'ls',
          'subagent',
          'task',
          'ask_user_question',
          'mcp',
          'complete_plan',
          'write_plan',
        ],
      ),
    ).toEqual([
      'read',
      'bash',
      'subagent',
      'ask_user_question',
      'grep',
      'find',
      'ls',
      'complete_plan',
      'task',
      'write_plan',
    ]);
    expect(planModeTools(['read'], ['read', 'ask_user_question'])).toEqual(['read']);
    expect(planModeTools(['read', 'ask_user_question'], ['read'])).toEqual(['read']);
  });

  it('preserves structured feedback only while it is active and registered', async () => {
    const fixture = createExtensionFixture(
      [],
      'Exit plan mode and start implementation',
      true,
      'no-ask-user',
      {},
      {
        askUserEnabled: false,
      },
    );
    await fixture.handler('session_start')({}, fixture.ctx);
    await fixture.invokeLeaderAction('plan.normal');

    expect(fixture.activeTools()).not.toContain('ask_user_question');

    await fixture.invokeLeaderAction('plan.exit');
    expect(fixture.activeTools()).not.toContain('ask_user_question');

    const liveFixture = createExtensionFixture([], 'Continue planning', true, 'live-ask-user');
    await liveFixture.handler('session_start')({}, liveFixture.ctx);
    await liveFixture.invokeLeaderAction('plan.normal');
    expect(liveFixture.activeTools()).toContain('ask_user_question');

    liveFixture.pi.setActiveTools(liveFixture.activeTools().filter((name) => name !== 'ask_user_question'));
    await liveFixture.invokeLeaderAction('plan.exit');
    expect(liveFixture.activeTools()).not.toContain('ask_user_question');
  });

  it('builds a configured model without mutating non-run subagent actions', () => {
    expect(
      planningSubagentModel(
        { model: 'anthropic/child:low', thinking: 'high' },
        { provider: 'openai-codex', id: 'original' },
      ),
    ).toBe('anthropic/child:high');
    expect(planningSubagentModel({ thinking: 'medium' }, { provider: 'openai-codex', id: 'original' })).toBe(
      'openai-codex/original:medium',
    );

    const input = {
      model: 'explicit/top',
      tasks: [{ model: 'explicit/task' }],
      chain: [
        { model: 'explicit/step' },
        {
          parallel: [{ model: 'explicit/parallel-a' }, { model: 'explicit/parallel-b' }],
        },
        { parallel: { model: 'explicit/dynamic' } },
      ],
    };
    configurePlanningSubagentInput(input, 'anthropic/child:high');

    expect(input).toEqual({
      model: 'explicit/top',
      tasks: [{ model: 'explicit/task' }],
      chain: [
        { model: 'explicit/step' },
        {
          parallel: [{ model: 'explicit/parallel-a' }, { model: 'explicit/parallel-b' }],
        },
        { parallel: { model: 'explicit/dynamic' } },
      ],
    });
  });

  it('applies the planning model to current run requests and task assignment batches', () => {
    const run = {
      action: 'run',
      requests: [
        { agent: 'package-dev', task: 'Inspect the package', model: 'explicit' },
        { agent: 'schema-explorer', task: 'Inspect schemas' },
      ],
    };
    const assign = {
      action: 'assign',
      assignments: [
        { id: 1, agent: 'package-dev', model: 'explicit' },
        { id: 2, agent: 'schema-explorer' },
      ],
    };

    configurePlanningSubagentInput(run, 'openai-codex/child:high');
    configurePlanningTaskInput(assign, 'openai-codex/child:high');

    expect(run.requests.map(({ model }) => model)).toEqual(['openai-codex/child:high', 'openai-codex/child:high']);
    expect(assign.assignments.map(({ model }) => model)).toEqual([
      'openai-codex/child:high',
      'openai-codex/child:high',
    ]);
    expect(assign).not.toHaveProperty('model');
  });

  it('prevents subagent outputs and worktrees at every execution level', () => {
    const input = {
      artifacts: true,
      output: 'single.md',
      outputSchema: { type: 'object' },
      progress: true,
      share: true,
      worktree: true,
      chainDir: '/tmp/custom-chain',
      sessionDir: '/tmp/custom-session',
      tasks: [{ output: 'task.md', progress: true, worktree: true }],
      chain: [
        {
          output: 'step.md',
          progress: true,
          parallel: [
            { output: 'parallel-a.md', worktree: true },
            { output: 'parallel-b.md', progress: true },
          ],
        },
      ],
    };

    constrainSubagentInput(input);

    expect(input).toEqual({
      artifacts: false,
      output: false,
      progress: false,
      share: false,
      worktree: false,
      tasks: [{ output: false, progress: false, worktree: false }],
      chain: [
        {
          output: false,
          progress: false,
          worktree: false,
          parallel: [
            { output: false, progress: false, worktree: false },
            { output: false, progress: false, worktree: false },
          ],
        },
      ],
    });
  });

  it('constrains native subagent actions without injecting unsupported fields', () => {
    const agents = { action: 'agents' };
    const run = { action: 'run', requests: [{ agent: 'planner', task: 'draft a plan' }] };
    const status = { action: 'status', id: 'run-1' };
    const legacyList = { action: 'list' };

    constrainSubagentInput(agents);
    constrainSubagentInput(run);
    constrainSubagentInput(status);
    constrainSubagentInput(legacyList);

    expect(agents).toEqual({ action: 'agents' });
    expect(run).toEqual({
      action: 'run',
      requests: [{ agent: 'planner', task: 'draft a plan' }],
      artifacts: false,
    });
    expect(status).toEqual({ action: 'status', id: 'run-1' });
    expect(legacyList).toEqual({ action: 'list' });
  });

  it('preserves concurrent planning while disabling parallel child write outputs', () => {
    const input = {
      concurrency: 3,
      tasks: [
        { agent: 'planner', output: 'first.md', progress: true, worktree: true },
        { agent: 'reviewer', output: 'second.md', progress: true, worktree: true },
        { agent: 'scout', output: 'third.md', progress: true, worktree: true },
      ],
    };

    constrainSubagentInput(input);

    expect(input).toMatchObject({
      concurrency: 3,
      tasks: [
        { agent: 'planner', output: false, progress: false, worktree: false },
        { agent: 'reviewer', output: false, progress: false, worktree: false },
        { agent: 'scout', output: false, progress: false, worktree: false },
      ],
    });
  });

  it('blocks subagent actions that mutate configuration or scheduled work', () => {
    expect(isBlockedSubagentManagementAction('create')).toBe(true);
    expect(isBlockedSubagentManagementAction('schedule')).toBe(true);
    expect(isBlockedSubagentManagementAction('append-step')).toBe(true);
    expect(isBlockedSubagentManagementAction('grant-spawn-budget')).toBe(true);
    expect(isBlockedSubagentManagementAction('list')).toBe(false);
    expect(isBlockedSubagentManagementAction('status')).toBe(false);
    expect(isBlockedSubagentManagementAction('stop')).toBe(false);
    expect(isBlockedSubagentManagementAction(undefined)).toBe(false);
  });

  it('preserves live autonomous-voice catalog access without restoring stale access', async () => {
    const fixture = createExtensionFixture();
    await fixture.handler('session_start')({}, fixture.ctx);
    fixture.pi.setActiveTools([...fixture.activeTools(), MINOR_MODE_TOOL_NAME]);

    await fixture.invokeLeaderAction('plan.normal');
    expect(fixture.activeTools()).toContain(MINOR_MODE_TOOL_NAME);

    fixture.pi.setActiveTools(fixture.activeTools().filter((name) => name !== MINOR_MODE_TOOL_NAME));
    await fixture.invokeLeaderAction('plan.debug');
    expect(fixture.activeTools()).not.toContain(MINOR_MODE_TOOL_NAME);

    await fixture.invokeLeaderAction('plan.exit');
    expect(fixture.activeTools()).not.toContain(MINOR_MODE_TOOL_NAME);
  });

  it('routes catalog actions through the provider-owned Plan mode handle', async () => {
    const fixture = createExtensionFixture();
    await fixture.handler('session_start')({}, fixture.ctx);

    await expect(fixture.invokeModeAction('activate', { flavor: 'invalid' })).rejects.toThrow(
      'A valid plan flavor is required',
    );
    await expect(fixture.invokeModeAction('activate', { flavor: 'normal' })).resolves.toEqual({
      message: 'Plan mode is active with the normal flavor.',
    });
    await expect(fixture.invokeModeAction('deactivate')).resolves.toEqual({ message: 'Plan mode deactivated.' });
    await expect(fixture.invokeModeAction('unknown')).rejects.toThrow('Unknown plan mode action');
  });

  it('registers serialized plan voice capabilities only for Doom integrations', async () => {
    const fixture = createExtensionFixture(
      [],
      'Exit plan mode and start implementation',
      true,
      'plan-voice-capability-session',
    );
    await fixture.handler('session_start')({}, fixture.ctx);

    const session = fixture.voiceTools.bindSession('plan-voice-capability-session', fixture.ctx);
    session.setActive(true);
    const catalog = session.describe();
    expect(catalog.tools.map(({ name }) => name)).toEqual(['activate_plan', 'exit_plan']);

    const result = await session.executeBatch(
      {
        catalogToken: catalog.catalogToken,
        calls: [
          { name: 'activate_plan', input: { flavor: 'normal' } },
          { name: 'activate_plan', input: { flavor: 'normal' } },
          { name: 'activate_plan', input: { flavor: 'debug' } },
          { name: 'activate_plan', input: { flavor: 'fable' } },
          { name: 'exit_plan', input: {} },
        ],
      },
      fixture.ctx,
    );
    expect(result.status).toBe('completed');
    expect(result.results.map(({ result: value }) => value)).toEqual([
      { active: true, flavor: 'normal', changed: true },
      { active: true, flavor: 'normal', changed: false },
      { active: true, flavor: 'debug', changed: true },
      { active: true, flavor: 'fable', changed: true },
      { active: false, flavor: null, changed: true },
    ]);
    expect(fixture.activeTools()).toEqual(['read', 'bash', 'edit', 'write', 'subagent', 'ask_user_question', 'mcp']);
    expect(
      fixture.telemetryRecords.some(({ attributes }) => attributes?.[PLAN_TRIGGER_ATTRIBUTE] === 'voice_tool'),
    ).toBe(true);

    const cancelledController = new AbortController();
    cancelledController.abort(new Error('cancelled before queue'));
    const cancelled = await session.executeBatch(
      {
        catalogToken: session.describe().catalogToken,
        calls: [{ name: 'activate_plan', input: { flavor: 'normal' } }],
      },
      fixture.ctx,
      { signal: cancelledController.signal },
    );
    expect(cancelled.results[0]?.error?.code).toBe('VOICE_TOOL_CANCELLED');
    expect(fixture.activeTools()).not.toContain('complete_plan');

    await fixture.handler('session_shutdown')({}, fixture.ctx);
    session.dispose();

    const standard = createExtensionFixture(
      [],
      'Exit plan mode and start implementation',
      true,
      'plan-voice-standard-session',
      {},
      { doomIntegrations: false },
    );
    await standard.handler('session_start')({}, standard.ctx);
    const standardSession = standard.voiceTools.bindSession('plan-voice-standard-session', standard.ctx);
    standardSession.setActive(true);
    expect(standardSession.describe().tools).toEqual([]);
    await standard.handler('session_shutdown')({}, standard.ctx);
    standardSession.dispose();
  });

  it('keeps live voice tools and unrelated tools without resurrecting stale voice tools', async () => {
    const fixture = createExtensionFixture(
      [],
      'Exit plan mode and start implementation',
      true,
      'plan-live-facades-session',
    );
    const unrelatedTool = UNRELATED_TOOL_NAME;
    const voiceToolNames = new Set<string>(VOICE_MODE_TOOL_NAMES);
    await fixture.handler('session_start')({}, fixture.ctx);
    fixture.pi.setActiveTools([...fixture.activeTools(), unrelatedTool, ...VOICE_MODE_TOOL_NAMES]);

    await fixture.invokeLeaderAction('plan.normal');
    expect(fixture.activeTools()).toEqual(expect.arrayContaining([...VOICE_MODE_TOOL_NAMES, unrelatedTool]));
    await expect(
      fixture.handler('tool_call')({ toolName: 'narrate', input: { text: 'Planning update.' } }, fixture.ctx),
    ).resolves.toBeUndefined();

    fixture.pi.setActiveTools(fixture.activeTools().filter((name) => !voiceToolNames.has(name)));
    await fixture.invokeLeaderAction('plan.debug');
    expect(fixture.activeTools()).not.toEqual(expect.arrayContaining([...VOICE_MODE_TOOL_NAMES]));
    expect(fixture.activeTools()).not.toContain('narrate');
    expect(fixture.activeTools()).toContain(unrelatedTool);

    await fixture.invokeLeaderAction('plan.exit');
    expect(fixture.activeTools()).toContain(unrelatedTool);
    expect(fixture.activeTools()).not.toEqual(expect.arrayContaining([...VOICE_MODE_TOOL_NAMES]));

    fixture.pi.setActiveTools([...fixture.activeTools(), ...VOICE_MODE_TOOL_NAMES]);
    await fixture.invokeLeaderAction('plan.fable');
    expect(fixture.activeTools()).toEqual(expect.arrayContaining([...VOICE_MODE_TOOL_NAMES]));
    await fixture.invokeLeaderAction('plan.exit');
    expect(fixture.activeTools()).toEqual(expect.arrayContaining([...VOICE_MODE_TOOL_NAMES]));
  });

  it('toggles plan mode, blocks writes, constrains subagents, and restores tools', async () => {
    const fixture = createExtensionFixture();
    await fixture.handler('session_start')({}, fixture.ctx);

    await fixture.invokeLeaderAction('plan.normal');
    expect(fixture.activeTools()).toEqual([
      'read',
      'bash',
      'subagent',
      'ask_user_question',
      'grep',
      'find',
      'ls',
      'complete_plan',
      'task',
      'write_plan',
    ]);
    expect(fixture.appendedEntries.at(-1)?.data).toMatchObject({ version: 2, activeFlavor: 'normal' });
    expect(fixture.latestModeState()).toMatchObject({ activation: 'active', modelContextVariant: 'normal' });
    expect(fixture.latestModeItem()).toMatchObject({ label: 'Plan', detail: 'normal - read only' });
    expect(fixture.latestSubagentPolicy()).toEqual({
      owner: '@agimon-ai/doompi-plan',
      allowedTools: ['read', 'bash', 'grep', 'find', 'ls', 'mcp'],
      requiredTools: ['bash', 'mcp'],
      allowMcpTools: true,
      allowedExternalProfiles: [],
      denyExtensions: false,
    });
    expect(fixture.latestModeItem()).toMatchObject({ label: 'Plan', detail: 'normal - read only' });

    await expect(
      fixture.handler('tool_call')({ toolName: 'ask_user_question', input: {} }, fixture.ctx),
    ).resolves.toBeUndefined();
    await expect(fixture.handler('tool_call')({ toolName: 'bash', input: {} }, fixture.ctx)).resolves.toBeUndefined();
    await expect(fixture.handler('tool_call')({ toolName: 'write', input: {} }, fixture.ctx)).resolves.toMatchObject({
      block: true,
    });
    await expect(fixture.handler('tool_call')({ toolName: 'mcp', input: {} }, fixture.ctx)).resolves.toMatchObject({
      block: true,
    });
    await expect(
      fixture.handler('tool_call')({ toolName: 'subagent', input: { action: 'create' } }, fixture.ctx),
    ).resolves.toMatchObject({ block: true });

    const agentsInput = { toolName: 'subagent', input: { action: 'agents' } };
    await fixture.handler('tool_call')(agentsInput, fixture.ctx);
    expect(agentsInput.input).toEqual({ action: 'agents' });

    const runInput = {
      toolName: 'subagent',
      input: { action: 'run', requests: [{ agent: 'planner', task: 'draft a plan' }] },
    };
    await fixture.handler('tool_call')(runInput, fixture.ctx);
    expect(runInput.input).toEqual({
      action: 'run',
      requests: [{ agent: 'planner', task: 'draft a plan' }],
      artifacts: false,
    });

    const subagentInput = { toolName: 'subagent', input: { agent: 'planner', output: 'plan.md', progress: true } };
    await fixture.handler('tool_call')(subagentInput, fixture.ctx);
    expect(subagentInput.input).toMatchObject({
      artifacts: false,
      output: false,
      progress: false,
      share: false,
      worktree: false,
    });

    const promptResult = await fixture.handler('before_agent_start')({ systemPrompt: 'base prompt' }, fixture.ctx);
    expect(promptResult).toMatchObject({
      systemPrompt: expect.stringContaining('[PLAN MODE ACTIVE]'),
    });
    expect((promptResult as { systemPrompt: string }).systemPrompt).toContain(
      'continue non-overlapping exploration or end your turn; completion notifications wake the parent session',
    );

    await fixture.invokeLeaderAction('plan.exit');
    expect(fixture.activeTools()).toEqual(['read', 'bash', 'edit', 'write', 'subagent', 'ask_user_question', 'mcp']);
    expect(fixture.appendedEntries.at(-1)?.data).toMatchObject({ version: 2 });
    expect(fixture.appendedEntries.at(-1)?.data).not.toHaveProperty('activeFlavor');
    // Exiting takes the label off the shared line rather than clearing a widget.
    expect(fixture.latestModeItem()).toBeUndefined();
    expect(fixture.subagentPolicyDisposals).toContain('@agimon-ai/doompi-plan');

    const staleContext = { customType: 'agent-harness-plan-mode-context' };
    await expect(
      fixture.handler('context')({ messages: [staleContext, { role: 'user' }] }, fixture.ctx),
    ).resolves.toEqual({ messages: [{ role: 'user' }] });
    await fixture.handler('session_shutdown')({}, fixture.ctx);
  });

  it('applies planning model overrides and prompts adaptive delegated planning', async () => {
    const fixture = createExtensionFixture([], 'Exit plan mode and start implementation', true, 'configured-plan', {
      main: { model: 'anthropic/planner', thinking: 'max' },
      subagents: { model: 'openai-codex/child', thinking: 'medium' },
    });
    await fixture.handler('session_start')({}, fixture.ctx);

    await fixture.invokeLeaderAction('plan.normal');

    expect(fixture.currentModel()).toEqual({ provider: 'anthropic', id: 'planner' });
    expect(fixture.thinkingLevel()).toBe('max');
    expect(fixture.appendedEntries.at(-1)?.data).toMatchObject({
      version: 2,
      activeFlavor: 'normal',
      originalSnapshot: {
        model: { provider: 'openai-codex', id: 'original' },
        thinking: 'low',
      },
    });

    const subagentInput = {
      toolName: 'subagent',
      input: {
        action: 'run',
        requests: [
          { agent: 'package-dev', task: 'Inspect the package', model: 'explicit/model' },
          { agent: 'schema-explorer', task: 'Inspect schemas' },
        ],
      },
    };
    await fixture.handler('tool_call')(subagentInput, fixture.ctx);
    expect(subagentInput.input).toMatchObject({
      artifacts: false,
      requests: [{ model: 'openai-codex/child:medium' }, { model: 'openai-codex/child:medium' }],
    });
    const agentsInput = { toolName: 'subagent', input: { action: 'agents', scope: 'both' } };
    await fixture.handler('tool_call')(agentsInput, fixture.ctx);
    expect(agentsInput.input).toEqual({ action: 'agents', scope: 'both' });
    const taskInput = {
      toolName: 'task',
      input: {
        action: 'assign',
        assignments: [
          { id: 1, agent: 'package-dev' },
          { id: 2, agent: 'schema-explorer', model: 'explicit/model' },
        ],
      },
    };
    await fixture.handler('tool_call')(taskInput, fixture.ctx);
    expect(taskInput.input.assignments).toEqual([
      { id: 1, agent: 'package-dev', model: 'openai-codex/child:medium' },
      { id: 2, agent: 'schema-explorer', model: 'openai-codex/child:medium' },
    ]);
    expect(taskInput.input).not.toHaveProperty('model');

    const prompt = (await fixture.handler('before_agent_start')({ systemPrompt: 'base prompt' }, fixture.ctx)) as {
      systemPrompt: string;
    };
    expect(prompt.systemPrompt).toContain('first call subagent with action "agents"');
    expect(prompt.systemPrompt).toContain('create a provisional task graph');
    expect(prompt.systemPrompt).toContain('perform one to three review passes');
    expect(prompt.systemPrompt).toContain('add, rewrite, delete, cancel, reassign, or change blockedBy relationships');
    expect(prompt.systemPrompt).toContain('Every plan must end with a delegated planning-draft stage');
    expect(prompt.systemPrompt).toContain('A single-boundary plan gets one planning draft');
    expect(prompt.systemPrompt).toContain('gets two planning drafts concurrently');
    expect(prompt.systemPrompt).toContain('Use three concurrent drafts instead');
    expect(prompt.systemPrompt).toContain('discovered "planner" agent with context "fork"');
    expect(prompt.systemPrompt).toContain('one-shot inlineAgent');
    expect(prompt.systemPrompt).toContain(
      'assign the same draft task through the task tool with a focused inlineAgent',
    );
    expect(prompt.systemPrompt).toContain('After all planning drafts complete');
    expect(prompt.systemPrompt).toContain('pick the strongest draft');
    expect(prompt.systemPrompt).toContain('main agent owns and synthesizes the final plan');
    expect(prompt.systemPrompt).not.toContain('Never delegate final synthesis');

    await fixture.invokeLeaderAction('plan.exit');
    expect(fixture.currentModel()).toEqual({ provider: 'openai-codex', id: 'original' });
    expect(fixture.thinkingLevel()).toBe('low');
    expect(fixture.setModel).toHaveBeenCalledTimes(2);
    expect(fixture.setThinkingLevel).toHaveBeenLastCalledWith('low');
  });

  it('re-reads Doom planning settings each time plan mode is enabled', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-plan-config-'));
    const configDirectory = path.join(repoRoot, '.doom');
    const configPath = path.join(configDirectory, 'config.yaml');
    const rootKey = 'DOOMPI_ROOT';
    const previousRoot = process.env[rootKey];
    const writeConfig = (model: string, thinking: PlanningThinkingLevel): void => {
      fs.writeFileSync(
        configPath,
        `modes:\n  planning:\n    main:\n      model: ${model}\n      thinking: ${thinking}\n`,
      );
    };

    fs.mkdirSync(configDirectory, { recursive: true });
    writeConfig('anthropic/planner', 'max');
    process.env[rootKey] = repoRoot;
    // The store caches this process's state, and the root is being changed
    // underneath it here rather than through the store.
    resetHarnessStore();

    try {
      const fixture = createExtensionFixture(
        [],
        'Exit plan mode and start implementation',
        true,
        'live-config-plan',
        loadPlanningModeConfig,
      );
      await fixture.handler('session_start')({}, fixture.ctx);

      await fixture.invokeLeaderAction('plan.normal');
      expect(fixture.currentModel()).toEqual({ provider: 'anthropic', id: 'planner' });
      expect(fixture.thinkingLevel()).toBe('max');

      await fixture.invokeLeaderAction('plan.exit');
      expect(fixture.currentModel()).toEqual({ provider: 'openai-codex', id: 'original' });
      expect(fixture.thinkingLevel()).toBe('low');

      writeConfig('openai-codex/alternate', 'high');
      await fixture.invokeLeaderAction('plan.normal');
      expect(fixture.currentModel()).toEqual({ provider: 'openai-codex', id: 'alternate' });
      expect(fixture.thinkingLevel()).toBe('high');

      await fixture.invokeLeaderAction('plan.exit');
      expect(fixture.currentModel()).toEqual({ provider: 'openai-codex', id: 'original' });
      expect(fixture.thinkingLevel()).toBe('low');
    } finally {
      if (previousRoot === undefined) delete process.env[rootKey];
      else process.env[rootKey] = previousRoot;
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('stays disabled when current Doom planning settings cannot be read', async () => {
    const fixture = createExtensionFixture(
      [],
      'Exit plan mode and start implementation',
      true,
      'invalid-config-plan',
      () => {
        throw new Error('invalid Doom config');
      },
    );
    await fixture.handler('session_start')({}, fixture.ctx);
    const toolsBeforeAttempt = fixture.activeTools();

    await fixture.invokeLeaderAction('plan.normal');

    expect(fixture.activeTools()).toEqual(toolsBeforeAttempt);
    await expect(fixture.completePlan()).resolves.toMatchObject({
      content: [{ text: 'Plan mode is already disabled.' }],
      details: { exited: false },
    });
    expect(fixture.appendedEntries).toEqual([]);
  });

  it('stays disabled when persisted plan mode cannot read current Doom settings', async () => {
    const fixture = createExtensionFixture(
      [
        {
          type: 'custom',
          customType: 'agent-harness-plan-mode',
          data: {
            enabled: true,
            toolsBeforePlanMode: ['read', 'bash', 'edit', 'write', 'subagent'],
          },
        },
      ],
      'Exit plan mode and start implementation',
      true,
      'invalid-persisted-config-plan',
      () => {
        throw new Error('invalid persisted Doom config');
      },
    );
    const toolsBeforeAttempt = fixture.activeTools();

    await expect(fixture.handler('session_start')({}, fixture.ctx)).rejects.toThrow('invalid persisted Doom config');

    expect(fixture.activeTools()).toEqual(toolsBeforeAttempt);
    await expect(fixture.completePlan()).resolves.toMatchObject({
      content: [{ text: 'Plan mode is already disabled.' }],
      details: { exited: false },
    });
    expect(fixture.appendedEntries).toEqual([]);
  });

  it('extracts visible plan text and derives a meaningful filename slug', () => {
    expect(planTitleSlug('# Hook Design: Concurrent Plans')).toBe('hook-design-concurrent-plans');
    expect(planTitleSlug('No heading')).toBe('implementation-plan');
    expect(
      visiblePlanForToolCall(
        [
          {
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: '# Plan' },
                { type: 'text', text: 'Review this.' },
                { type: 'toolCall', id: 'target', name: 'write_plan', arguments: {} },
                { type: 'text', text: 'Not part of the plan.' },
              ],
            },
          },
          {
            type: 'message',
            message: {
              role: 'assistant',
              content: [{ type: 'toolCall', id: 'other', name: 'write_plan', arguments: {} }],
            },
          },
        ],
        'target',
      ),
    ).toBe('# Plan\n\nReview this.');
  });

  it('writes one session plan outside the repository and rejects unsafe destinations', async () => {
    await withPiSession(async (sessionDirectory) => {
      const fixture = createExtensionFixture();
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      const sessionId = planSessionIdentifier('plan-mode-test-session');
      const planPath = expectedPlanPath(sessionDirectory, 'implementation-plan', fixture);

      await expect(fixture.writePlan('# Implementation plan\n')).resolves.toMatchObject({
        details: {
          written: true,
          path: planPath,
          phase: 'writing',
          durationMs: expect.any(Number),
        },
      });
      expect(fs.readFileSync(planPath, 'utf8')).toBe('# Implementation plan');
      expect(fixture.appendedEntries.at(-1)).toMatchObject({
        customType: 'agent-harness-plan-document',
        data: { content: '# Implementation plan', path: planPath, sessionId },
      });
      expect(fixture.planUpdates).toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ phase: 'checking' }) }),
      );
      expect(fixture.planUpdates).toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ phase: 'writing' }) }),
      );

      await fixture.writePlan('# Updated plan');
      expect(fs.readFileSync(planPath, 'utf8')).toBe('# Updated plan');
      expect(fs.existsSync(expectedPlanPath(sessionDirectory, 'updated-plan', fixture))).toBe(false);
      const currentContext = await fixture.handler('before_agent_start')({ systemPrompt: 'base prompt' }, fixture.ctx);
      expect(currentContext).toMatchObject({ systemPrompt: expect.stringContaining('# Updated plan') });
      expect((currentContext as { systemPrompt: string }).systemPrompt).not.toContain('# Implementation plan');

      fs.rmSync(planPath);
      fs.symlinkSync(path.join(sessionDirectory, 'outside.md'), planPath);
      await expect(fixture.writePlan('unsafe')).resolves.toMatchObject({ details: { written: false } });
      expect(fs.existsSync(path.join(sessionDirectory, 'outside.md'))).toBe(false);

      fs.rmSync(planPath);
      fs.mkdirSync(planPath);
      await expect(fixture.writePlan('unsafe')).resolves.toMatchObject({ details: { written: false } });

      fs.rmSync(path.join(sessionDirectory, 'plans'), { recursive: true });
      const outsideDirectory = path.join(sessionDirectory, 'outside-plans');
      fs.mkdirSync(outsideDirectory);
      fs.symlinkSync(outsideDirectory, path.join(sessionDirectory, 'plans'));
      await expect(fixture.writePlan('unsafe')).resolves.toMatchObject({ details: { written: false } });
      expect(fs.readdirSync(outsideDirectory)).toEqual([]);
    });
  });

  it('isolates concurrent plan sessions with meaningful unique filenames', async () => {
    await withPiSession(async (sessionDirectory) => {
      const first = createExtensionFixture([], 'Exit plan mode and start implementation', true, 'session.a');
      const second = createExtensionFixture([], 'Exit plan mode and start implementation', true, 'SESSION.A');
      await first.handler('session_start')({}, first.ctx);
      await second.handler('session_start')({}, second.ctx);
      await first.invokeLeaderAction('plan.normal');
      await second.invokeLeaderAction('plan.normal');

      const firstResult = (await first.writePlan('# Hook Design')) as { details: { path: string } };
      const secondResult = (await second.writePlan('# Hook Design')) as { details: { path: string } };

      expect(firstResult.details.path).toBe(expectedPlanPath(sessionDirectory, 'hook-design', first));
      expect(secondResult.details.path).toBe(expectedPlanPath(sessionDirectory, 'hook-design', second));
      expect(firstResult.details.path).not.toBe(secondResult.details.path);
    });
  });

  it('allocates a new unique file after plan mode exits and is enabled again', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture();
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      const first = (await fixture.writePlan('# Hook Design')) as { details: { path: string } };

      await fixture.invokeLeaderAction('plan.exit');
      await fixture.invokeLeaderAction('plan.normal');
      const second = (await fixture.writePlan('# Hook Design')) as { details: { path: string } };

      expect(second.details.path).not.toBe(first.details.path);
      expect(fs.readFileSync(first.details.path, 'utf8')).toBe('# Hook Design');
      expect(fs.readFileSync(second.details.path, 'utf8')).toBe('# Hook Design');
    });
  });

  it('regenerates the plan id when the initial unique filename already exists', async () => {
    await withPiSession(async (sessionDirectory) => {
      const fixture = createExtensionFixture();
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      const collisionPath = expectedPlanPath(sessionDirectory, 'hook-design', fixture);
      fs.mkdirSync(path.dirname(collisionPath), { recursive: true });
      fs.writeFileSync(collisionPath, 'existing plan');

      const result = (await fixture.writePlan('# Hook Design')) as { details: { path: string } };

      expect(result.details.path).not.toBe(collisionPath);
      expect(fs.readFileSync(collisionPath, 'utf8')).toBe('existing plan');
      expect(fs.readFileSync(result.details.path, 'utf8')).toBe('# Hook Design');
    });
  });

  it('restores only the latest plan into context and starts new sessions clean', async () => {
    await withPiSession(async (sessionDirectory) => {
      const sessionId = planSessionIdentifier('plan-mode-test-session');
      const planPath = path.join(sessionDirectory, 'plans', `new-plan--${sessionId}.md`);
      const fixture = createExtensionFixture([
        {
          type: 'custom',
          customType: 'agent-harness-plan-document',
          data: {
            content: '# Old plan',
            path: planPath,
            sessionId,
            title: 'old-plan',
            writtenAt: '2026-07-30T00:00:00.000Z',
          },
        },
        {
          type: 'custom',
          customType: 'agent-harness-plan-document',
          data: {
            content: '# New plan',
            path: planPath,
            sessionId,
            title: 'new-plan',
            writtenAt: '2026-07-30T01:00:00.000Z',
          },
        },
      ]);
      await fixture.handler('session_start')({}, fixture.ctx);

      const restored = await fixture.handler('before_agent_start')({ systemPrompt: 'base prompt' }, fixture.ctx);
      expect(restored).toMatchObject({ systemPrompt: expect.stringContaining('# New plan') });
      expect((restored as { systemPrompt: string }).systemPrompt).not.toContain('# Old plan');

      const fresh = createExtensionFixture();
      await fresh.handler('session_start')({}, fresh.ctx);
      await expect(
        fresh.handler('before_agent_start')({ systemPrompt: 'base prompt' }, fresh.ctx),
      ).resolves.toBeUndefined();
    });
  });

  it('clears plan state and restores tools when Pi starts a new session', async () => {
    await withPiSession(async () => {
      const entries: unknown[] = [];
      const fixture = createExtensionFixture(entries);
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Existing plan');
      entries.length = 0;

      await fixture.handler('session_start')({}, fixture.ctx);

      expect(fixture.activeTools()).toEqual(['read', 'bash', 'edit', 'write', 'subagent', 'ask_user_question', 'mcp']);
      await expect(
        fixture.handler('before_agent_start')({ systemPrompt: 'base prompt' }, fixture.ctx),
      ).resolves.toBeUndefined();
    });
  });

  it('requires visible plan text and bounds a stalled write', async () => {
    await withPiSession(async (sessionDirectory) => {
      const fixture = createExtensionFixture();
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');

      const plansDirectory = path.join(sessionDirectory, 'plans');
      const planPath = expectedPlanPath(sessionDirectory, 'plan', fixture);
      await expect(fixture.writePlanWithoutDisplay()).rejects.toThrow('visible Markdown');
      expect(fs.existsSync(plansDirectory)).toBe(false);

      fs.mkdirSync(plansDirectory);
      fs.writeFileSync(planPath, 'old plan');
      vi.useFakeTimers();
      const mkdir = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(plansDirectory);
      const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation(async (target) => fs.lstatSync(target));
      const realpath = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (target) => fs.realpathSync(target));
      const stats = fs.lstatSync(planPath);
      const open = vi.spyOn(fs.promises, 'open').mockResolvedValue({
        close: vi.fn().mockResolvedValue(undefined),
        stat: vi.fn().mockResolvedValue(stats),
        truncate: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockImplementation(() => new Promise(() => {})),
      } as unknown as Awaited<ReturnType<typeof fs.promises.open>>);
      try {
        const pending = fixture.writePlan('# Plan');
        const rejection = expect(pending).rejects.toThrow('timed out during writing');
        await vi.advanceTimersByTimeAsync(WRITE_PLAN_TIMEOUT_MS);
        await rejection;
      } finally {
        mkdir.mockRestore();
        lstat.mockRestore();
        realpath.mockRestore();
        open.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it('honors Pi cancellation while writing a plan', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture();
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      const controller = new AbortController();
      controller.abort(new Error('cancelled by user'));

      await expect(fixture.writePlan('# Plan', controller.signal)).rejects.toThrow('cancelled by user');
    });
  });

  it('asks for interactive approval only after a visible plan is saved', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture();
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');

      await expect(fixture.completePlan()).resolves.toMatchObject({ details: { exited: false } });
      expect(fixture.selections).not.toHaveBeenCalled();

      await fixture.writePlan('# Plan');
      await expect(
        fixture.handler('before_agent_start')({ systemPrompt: 'base prompt' }, fixture.ctx),
      ).resolves.toMatchObject({
        systemPrompt: expect.stringContaining('call complete_plan without a decision'),
      });
      await expect(fixture.completePlan('exit')).rejects.toThrow('without a decision');
      expect(fixture.selections).not.toHaveBeenCalled();
      await expect(fixture.completePlan()).resolves.toMatchObject({ details: { exited: true } });
      expect(fixture.selections).toHaveBeenCalledWith('Plan complete. What would you like to do?', [
        'Exit plan mode and start implementation',
        'Continue planning',
      ]);
      expect(fixture.registeredTool('complete_plan')?.parameters).toMatchObject({
        properties: { decision: { enum: ['exit', 'continue'] } },
      });
      expect(fixture.registeredTool('complete_plan')?.parameters).not.toHaveProperty('required');
      expect(fixture.activeTools()).toEqual(['read', 'bash', 'edit', 'write', 'subagent', 'ask_user_question', 'mcp']);
      expect(fixture.appendedEntries.at(-1)?.data).toMatchObject({ version: 2 });
      expect(fixture.appendedEntries.at(-1)?.data).not.toHaveProperty('activeFlavor');
    });
  });

  it('hands plan review to active autonomous voice without opening a selector', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture(
        [],
        'Exit plan mode and start implementation',
        true,
        'voice-plan-exit',
        {},
        {
          autonomousVoice: true,
        },
      );
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Voice plan');

      const handoff = await fixture.completePlan();

      expect(handoff).toMatchObject({
        terminate: true,
        details: { delivery: 'voice', awaitingResponse: true, cancelled: false },
        content: [
          {
            text: expect.stringContaining('Plan complete. What would you like to do?'),
          },
        ],
      });
      expect(JSON.stringify(handoff)).toContain('Exit plan mode and start implementation');
      expect(JSON.stringify(handoff)).toContain('Continue planning');
      expect(JSON.stringify(handoff)).toContain("wait for the user's next message");
      expect(fixture.selections).not.toHaveBeenCalled();
      expect(fixture.narrationRequests).toEqual([
        { text: expect.stringContaining('Plan complete. What would you like to do?') },
      ]);

      await expect(fixture.completePlan()).rejects.toThrow('waiting for an explicit exit or continue decision');
      await expect(fixture.completePlan('exit')).resolves.toMatchObject({ details: { exited: true } });
      expect(fixture.narrationRequests).toHaveLength(1);
      expect(fixture.activeTools()).toEqual(['read', 'bash', 'edit', 'write', 'subagent', 'ask_user_question', 'mcp']);
    });
  });

  it('keeps plan mode active after an explicit autonomous-voice continue decision', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture(
        [],
        'Exit plan mode and start implementation',
        true,
        'voice-plan-continue',
        {},
        {
          autonomousVoice: true,
        },
      );
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Voice plan');

      await expect(fixture.completePlan()).resolves.toMatchObject({ terminate: true });
      await expect(fixture.completePlan('continue')).resolves.toMatchObject({ details: { exited: false } });
      expect(fixture.activeTools()).toContain('complete_plan');
      await expect(fixture.completePlan()).resolves.toMatchObject({
        content: [{ text: expect.stringContaining('save it with write_plan') }],
        details: { exited: false },
      });
      expect(fixture.selections).not.toHaveBeenCalled();
    });
  });

  it('falls back to the interactive review when autonomous narration fails', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture(
        [],
        'Exit plan mode and start implementation',
        true,
        'voice-plan-fallback',
        {},
        {
          autonomousVoice: true,
          narrationError: new Error('speaker unavailable'),
        },
      );
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Voice fallback plan');

      await expect(fixture.completePlan()).resolves.toMatchObject({ details: { exited: true } });
      expect(fixture.narrationRequests).toHaveLength(1);
      expect(fixture.selections).toHaveBeenCalledOnce();
      expect(fixture.telemetryRecords.filter(({ event }) => event === 'doom_plan.plan_review_completed')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: 'warn',
            error: expect.objectContaining({ message: 'speaker unavailable' }),
            attributes: { 'plan.outcome': 'narration_failed' },
          }),
        ]),
      );
    });
  });

  it.each([
    ['another provider', { voiceModeSource: '@agimon-ai/not-voice' }],
    ['another mode', { voiceModeId: 'voice-manual' }],
    ['inactive autonomous voice', { voiceModeActivation: 'inactive' as const }],
  ])('keeps plan review interactive for %s', async (_case, voiceOptions) => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture(
        [],
        'Continue planning',
        true,
        `voice-plan-${_case}`,
        {},
        {
          autonomousVoice: true,
          ...voiceOptions,
        },
      );
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Interactive plan');

      await expect(fixture.completePlan()).resolves.toMatchObject({ details: { exited: false } });
      expect(fixture.narrationRequests).toEqual([]);
      expect(fixture.selections).toHaveBeenCalledOnce();
    });
  });

  it('continues planning when the user declines or interaction is unavailable', async () => {
    await withPiSession(async () => {
      const continuing = createExtensionFixture([], 'Continue planning');
      await continuing.handler('session_start')({}, continuing.ctx);
      await continuing.invokeLeaderAction('plan.normal');
      await continuing.writePlan('# Plan');
      await expect(continuing.completePlan()).resolves.toMatchObject({ details: { exited: false } });
      expect(continuing.activeTools()).toContain('complete_plan');
      await expect(continuing.completePlan()).resolves.toMatchObject({ details: { exited: false } });
      expect(continuing.selections).toHaveBeenCalledTimes(1);

      const nonInteractive = createExtensionFixture([], 'Exit plan mode and start implementation', false);
      await nonInteractive.handler('session_start')({}, nonInteractive.ctx);
      await nonInteractive.invokeLeaderAction('plan.normal');
      await nonInteractive.writePlan('# Plan');
      await expect(nonInteractive.completePlan()).resolves.toMatchObject({ details: { exited: false } });
      expect(nonInteractive.selections).not.toHaveBeenCalled();
      expect(nonInteractive.activeTools()).toContain('complete_plan');
    });
  });

  it('reports when the completion tool is called outside plan mode', async () => {
    const fixture = createExtensionFixture();
    await fixture.handler('session_start')({}, fixture.ctx);

    await expect(fixture.completePlan()).resolves.toMatchObject({
      content: [{ text: 'Plan mode is already disabled.' }],
      details: { exited: false },
    });
    expect(fixture.selections).not.toHaveBeenCalled();
  });

  it('migrates v1 persisted plan mode and exits through the typed leader action', async () => {
    const fixture = createExtensionFixture(
      [
        {
          type: 'custom',
          customType: 'agent-harness-plan-mode',
          data: {
            enabled: true,
            toolsBeforePlanMode: ['read', 'bash', 'edit', 'write', 'subagent'],
            modelBeforePlanMode: { provider: 'openai-codex', id: 'original' },
            thinkingBeforePlanMode: 'low',
          },
        },
      ],
      'Exit plan mode and start implementation',
      true,
      'persisted-plan',
      { main: { model: 'anthropic/planner', thinking: 'max' } },
    );

    expect(
      parsePersistedPlanState({
        enabled: true,
        toolsBeforePlanMode: ['read', 'bash', 'edit', 'write', 'subagent'],
        modelBeforePlanMode: { provider: 'openai-codex', id: 'original' },
        thinkingBeforePlanMode: 'low',
      }),
    ).toMatchObject({
      version: 2,
      activeFlavor: 'normal',
      originalSnapshot: {
        tools: ['read', 'bash', 'edit', 'write', 'subagent'],
        model: { provider: 'openai-codex', id: 'original' },
        thinking: 'low',
      },
    });

    await fixture.handler('session_start')({}, fixture.ctx);
    expect(fixture.currentModel()).toEqual({ provider: 'anthropic', id: 'planner' });
    expect(fixture.thinkingLevel()).toBe('max');
    expect(fixture.activeTools()).toEqual([
      'read',
      'bash',
      'subagent',
      'grep',
      'find',
      'ls',
      'complete_plan',
      'task',
      'write_plan',
    ]);
    await expect(fixture.handler('context')({ messages: [] }, fixture.ctx)).resolves.toEqual({ messages: [] });
    await expect(fixture.handler('tool_call')({ toolName: 'read', input: {} }, fixture.ctx)).resolves.toBeUndefined();

    expect(fixture.appendedEntries.at(-1)).toMatchObject({
      customType: 'agent-harness-plan-mode',
      data: {
        version: 2,
        activeFlavor: 'normal',
        originalSnapshot: {
          tools: ['read', 'bash', 'edit', 'write', 'subagent'],
          model: { provider: 'openai-codex', id: 'original' },
          thinking: 'low',
        },
      },
    });

    await fixture.invokeLeaderAction('plan.exit');
    expect(fixture.activeTools()).toEqual(['read', 'bash', 'edit', 'write', 'subagent']);
    expect(fixture.currentModel()).toEqual({ provider: 'openai-codex', id: 'original' });
    expect(fixture.thinkingLevel()).toBe('low');
    expect(fixture.statuses).toHaveBeenLastCalledWith('plan-mode', undefined);
  });
});

describe('plan mode telemetry', () => {
  const recordsFor = (fixture: HarnessExtensionFixture, event: string): RecordedTelemetry[] =>
    fixture.telemetryRecords.filter((record) => record.event === event);

  it('reports activation and deactivation with the trigger that caused it', async () => {
    const fixture = createExtensionFixture([], 'Exit plan mode and start implementation', true, 'telemetry-toggle', {
      main: { model: 'anthropic/planner', thinking: 'high' },
    });
    await fixture.handler('session_start')({}, fixture.ctx);

    await fixture.invokeLeaderAction('plan.normal');
    expect(recordsFor(fixture, 'doom_plan.mode_enabled')).toMatchObject([
      {
        level: 'info',
        attributes: {
          'plan.trigger': 'leader',
          'plan.model': 'anthropic/planner',
          'plan.thinking': 'high',
          'plan.tool.count': expect.any(Number),
        },
      },
    ]);

    await fixture.invokeLeaderAction('plan.exit');
    expect(recordsFor(fixture, 'doom_plan.mode_disabled')).toMatchObject([
      { level: 'info', attributes: { 'plan.trigger': 'leader', 'plan.written': false } },
    ]);
  });

  it('marks a restored session apart from a user toggle', async () => {
    const fixture = createExtensionFixture(
      [
        {
          type: 'custom',
          customType: 'agent-harness-plan-mode',
          data: { enabled: true, toolsBeforePlanMode: ['read', 'bash', 'edit', 'write', 'subagent'] },
        },
      ],
      'Exit plan mode and start implementation',
      true,
      'telemetry-restore',
    );

    await fixture.handler('session_start')({}, fixture.ctx);

    expect(recordsFor(fixture, 'doom_plan.mode_enabled')).toMatchObject([
      { level: 'info', attributes: { 'plan.trigger': 'session_restore' } },
    ]);
  });

  it('reports a malformed Doom config as an error and still refuses to enable', async () => {
    const fixture = createExtensionFixture(
      [],
      'Exit plan mode and start implementation',
      true,
      'telemetry-config',
      () => {
        throw new Error('invalid Doom config');
      },
    );
    await fixture.handler('session_start')({}, fixture.ctx);

    await fixture.invokeLeaderAction('plan.normal');

    expect(recordsFor(fixture, 'doom_plan.config_load_failed')).toMatchObject([
      { level: 'error', error: expect.any(Error), attributes: { 'plan.trigger': 'leader' } },
    ]);
    expect(recordsFor(fixture, 'doom_plan.mode_enabled')).toMatchObject([
      { level: 'error', attributes: { 'plan.trigger': 'leader', 'plan.action': 'plan.normal' } },
    ]);
  });

  it('warns when a configured planning model cannot be resolved', async () => {
    const fixture = createExtensionFixture([], 'Exit plan mode and start implementation', true, 'telemetry-model', {
      main: { model: 'acme/ghost' },
    });
    await fixture.handler('session_start')({}, fixture.ctx);

    await fixture.invokeLeaderAction('plan.normal');

    expect(recordsFor(fixture, 'doom_plan.model_resolve_failed')).toMatchObject([
      {
        level: 'warn',
        attributes: { 'plan.model': 'acme/ghost', 'plan.model.phase': 'apply', 'plan.model.reason': 'not_found' },
      },
    ]);
  });

  it('reports a written plan with its size and whether it revised an existing file', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture([], 'Exit plan mode and start implementation', true, 'telemetry-write');
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');

      await fixture.writePlan('# Implementation plan\n');
      await fixture.writePlan('# Implementation plan revised\n');

      expect(recordsFor(fixture, 'doom_plan.plan_written')).toMatchObject([
        {
          level: 'info',
          attributes: {
            'plan.written': true,
            'plan.bytes': '# Implementation plan'.length,
            'plan.revised': false,
            'plan.duration_ms': expect.any(Number),
          },
        },
        { level: 'info', attributes: { 'plan.revised': true } },
      ]);
    });
  });

  it('warns when a plan destination is refused as unsafe', async () => {
    await withPiSession(async (sessionDirectory) => {
      const fixture = createExtensionFixture([], 'Exit plan mode and start implementation', true, 'telemetry-unsafe');
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Implementation plan\n');
      const planPath = expectedPlanPath(sessionDirectory, 'implementation-plan', fixture);

      fs.rmSync(planPath);
      fs.mkdirSync(planPath);
      await expect(fixture.writePlan('unsafe')).resolves.toMatchObject({ details: { written: false } });

      expect(recordsFor(fixture, 'doom_plan.write_plan_unsafe_path')).toMatchObject([
        {
          level: 'warn',
          attributes: { 'plan.phase': 'writing', 'plan.refusal': 'invalid_destination' },
        },
      ]);
    });
  });

  it('reports a write_plan call that skipped presenting the plan in chat', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture([], 'Exit plan mode and start implementation', true, 'telemetry-hidden');
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');

      await expect(fixture.writePlanWithoutDisplay()).rejects.toThrow('Present the complete implementation plan');

      expect(recordsFor(fixture, 'doom_plan.write_plan_failed')).toMatchObject([
        { level: 'error', attributes: { 'plan.reason': 'missing_visible_plan' } },
      ]);
    });
  });

  it('reports each plan review outcome', async () => {
    await withPiSession(async () => {
      const exiting = createExtensionFixture([], 'Exit plan mode and start implementation', true, 'telemetry-exit');
      await exiting.handler('session_start')({}, exiting.ctx);
      await exiting.invokeLeaderAction('plan.normal');
      await exiting.writePlan('# Plan');
      await exiting.completePlan();
      expect(recordsFor(exiting, 'doom_plan.plan_review_completed')).toMatchObject([
        { level: 'info', attributes: { 'plan.outcome': 'exited' } },
      ]);
      expect(recordsFor(exiting, 'doom_plan.mode_disabled')).toMatchObject([
        { level: 'info', attributes: { 'plan.trigger': 'plan_approved', 'plan.written': true } },
      ]);

      const continuing = createExtensionFixture([], 'Continue planning', true, 'telemetry-continue');
      await continuing.handler('session_start')({}, continuing.ctx);
      await continuing.invokeLeaderAction('plan.normal');
      await continuing.writePlan('# Plan');
      await continuing.completePlan();
      expect(recordsFor(continuing, 'doom_plan.plan_review_completed')).toMatchObject([
        { level: 'info', attributes: { 'plan.outcome': 'continued' } },
      ]);

      const headless = createExtensionFixture([], 'Exit plan mode and start implementation', false, 'telemetry-no-ui');
      await headless.handler('session_start')({}, headless.ctx);
      await headless.invokeLeaderAction('plan.normal');
      await headless.writePlan('# Plan');
      await headless.completePlan();
      expect(recordsFor(headless, 'doom_plan.plan_review_completed')).toMatchObject([
        { level: 'info', attributes: { 'plan.outcome': 'no_ui' } },
      ]);
    });
  });

  it('shuts the sink down when the Pi session ends', async () => {
    const fixture = createExtensionFixture([], 'Exit plan mode and start implementation', true, 'telemetry-shutdown');
    await fixture.handler('session_start')({}, fixture.ctx);

    await fixture.handler('session_shutdown')({}, fixture.ctx);

    expect(fixture.telemetryShutdown).toHaveBeenCalledOnce();
  });
});

/**
 * What the cockpit needs from the session half.
 *
 * The browser never talks to this extension. It reads a status line the
 * session publishes and calls an API server in a different process, and that
 * server finds the plan only through the record written here. So what these
 * pin is the handoff: that a written plan is announced, that the announcement
 * survives the mode it was written in, and that an edit made on the other side
 * of the handoff is the plan the agent then implements.
 */
describe('the plan in the cockpit', () => {
  const PLAN_STATUS = 'doom-plan-document';

  /** A pointer that keeps its records in memory, standing in for the disk. */
  function recordingPointers(): PlanPointerPort & { records: Map<string, PlanPointerRecord> } {
    const records = new Map<string, PlanPointerRecord>();
    return {
      records,
      read: (sessionId) => records.get(sessionId),
      write: (sessionId, record) => {
        records.set(sessionId, record);
      },
      clear: (sessionId) => {
        records.delete(sessionId);
      },
    };
  }

  /** The newest value the session published on a status key, or undefined. */
  function statusFor(fixture: HarnessExtensionFixture, key: string): string | undefined {
    const call = [...fixture.statuses.mock.calls].reverse().find(([name]) => name === key);
    return call?.[1] as string | undefined;
  }

  const recordsFor = (fixture: HarnessExtensionFixture, event: string): RecordedTelemetry[] =>
    fixture.telemetryRecords.filter((record) => record.event === event);

  it('records where the plan landed, so the session API can find it', async () => {
    await withPiSession(async (sessionDirectory) => {
      const pointers = recordingPointers();
      const fixture = createExtensionFixture([], undefined, true, 'cockpit-session', {}, { planPointers: pointers });
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');

      await fixture.writePlan('# Cockpit plan\n');

      expect(pointers.records.get('cockpit-session')).toMatchObject({
        path: expectedPlanPath(sessionDirectory, 'cockpit-plan', fixture),
        title: 'cockpit-plan',
        writtenAt: expect.any(String),
      });
    });
  });

  it('publishes the status the activity group appears on, naming the plan', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture([], undefined, true, 'cockpit-session', {}, {});
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');

      await fixture.writePlan('# Cockpit plan\n');

      expect(statusFor(fixture, PLAN_STATUS)).toContain('cockpit-plan');
    });
  });

  it('changes the status on a rewrite, which is how an open tab learns to re-read', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture([], undefined, true, 'cockpit-session', {}, {});
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Cockpit plan\n');
      const first = statusFor(fixture, PLAN_STATUS);

      vi.setSystemTime(new Date('2031-01-01T04:05:06.000Z'));
      await fixture.writePlan('# Cockpit plan\n\nrevised');
      vi.useRealTimers();

      expect(statusFor(fixture, PLAN_STATUS)).not.toBe(first);
    });
  });

  it('keeps the plan announced after the mode is exited, which is when it is read', async () => {
    // Exiting is when the agent starts implementing. Retiring the group there
    // would take the plan away at the moment a reader most wants it open.
    await withPiSession(async () => {
      const pointers = recordingPointers();
      const fixture = createExtensionFixture(
        [],
        'Exit plan mode and start implementation',
        true,
        'cockpit-session',
        {},
        { planPointers: pointers },
      );
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Cockpit plan\n');

      await fixture.completePlan();

      expect(statusFor(fixture, 'plan-mode')).toBeUndefined();
      expect(statusFor(fixture, PLAN_STATUS)).toContain('cockpit-plan');
      expect(pointers.records.has('cockpit-session')).toBe(true);
    });
  });

  it('retires the announcement with the session, not with the mode', async () => {
    await withPiSession(async () => {
      const pointers = recordingPointers();
      const fixture = createExtensionFixture([], undefined, true, 'cockpit-session', {}, { planPointers: pointers });
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Cockpit plan\n');

      await fixture.handler('session_shutdown')({}, fixture.ctx);

      expect(statusFor(fixture, PLAN_STATUS)).toBeUndefined();
      expect(pointers.records.has('cockpit-session')).toBe(false);
    });
  });

  it('announces the plan a resumed session restores', async () => {
    await withPiSession(async () => {
      const pointers = recordingPointers();
      const stored = {
        type: 'custom',
        customType: 'agent-harness-plan-document',
        data: {
          content: '# Restored plan',
          path: '/plans/restored.md',
          sessionId: planSessionIdentifier('cockpit-session'),
          title: 'restored-plan',
          writtenAt: '2026-08-27T00:00:00.000Z',
        },
      };
      const fixture = createExtensionFixture(
        [stored],
        undefined,
        true,
        'cockpit-session',
        {},
        {
          planPointers: pointers,
        },
      );

      await fixture.handler('session_start')({}, fixture.ctx);

      expect(statusFor(fixture, PLAN_STATUS)).toContain('restored-plan');
      expect(pointers.records.get('cockpit-session')).toMatchObject({ path: '/plans/restored.md' });
    });
  });

  it('clears a stale pointer a session restoring no plan would otherwise inherit', async () => {
    await withPiSession(async () => {
      const pointers = recordingPointers();
      pointers.write('cockpit-session', { path: '/plans/gone.md', title: 'gone', writtenAt: 'earlier' });
      const fixture = createExtensionFixture([], undefined, true, 'cockpit-session', {}, { planPointers: pointers });

      await fixture.handler('session_start')({}, fixture.ctx);

      expect(pointers.records.has('cockpit-session')).toBe(false);
      expect(statusFor(fixture, PLAN_STATUS)).toBeUndefined();
    });
  });

  it('says nothing at all on the plan status until a plan is written', async () => {
    // A cockpit records a status key the first time it hears of it and never
    // drops it again, so clearing a key it has not seen is not a no-op: it
    // publishes the key as an empty string, and the dock shows the plan group
    // on a session that has written nothing. Silence is the only way to stay
    // absent.
    await withPiSession(async () => {
      const fixture = createExtensionFixture([], undefined, true, 'cockpit-session', {}, {});

      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.handler('before_agent_start')({ systemPrompt: 'base' }, fixture.ctx);

      expect(fixture.statuses.mock.calls.filter(([key]) => key === PLAN_STATUS)).toEqual([]);
    });
  });

  it('still retires a plan it did announce, so a restart does not strand the group', async () => {
    await withPiSession(async () => {
      const fixture = createExtensionFixture([], undefined, true, 'cockpit-session', {}, {});
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Cockpit plan\n');

      await fixture.handler('session_shutdown')({}, fixture.ctx);

      const published = fixture.statuses.mock.calls.filter(([key]) => key === PLAN_STATUS);
      expect(published.at(-1)?.[1]).toBeUndefined();
      expect(published.length).toBeGreaterThan(1);
    });
  });

  it('publishes an unstyled plan status when the host has no initialised theme', async () => {
    // Pi's ui.theme is a proxy over a global the TUI installs, so every access
    // throws in a headless runtime. A status colour is not worth failing the
    // hook that publishes it.
    await withPiSession(async () => {
      const fixture = createExtensionFixture([], undefined, true, 'headless-session', {}, {});
      (fixture.ctx as unknown as { ui: { theme: unknown } }).ui.theme = new Proxy(
        {},
        {
          get() {
            throw new Error('Theme not initialized. Call initTheme() first.');
          },
        },
      );

      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');

      expect(fixture.statuses).toHaveBeenCalledWith('plan-mode', 'plan:normal');
    });
  });
  it('does not fail a write when the pointer cannot be recorded', async () => {
    // The plan is on disk either way; losing a cockpit view is not worth
    // failing the write that produced it.
    await withPiSession(async () => {
      const failing: PlanPointerPort = {
        read: () => undefined,
        write: () => {
          throw new Error('the agent directory is read-only');
        },
        clear: () => undefined,
      };
      const fixture = createExtensionFixture([], undefined, true, 'cockpit-session', {}, { planPointers: failing });
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');

      await expect(fixture.writePlan('# Cockpit plan\n')).resolves.toMatchObject({ details: { written: true } });
      expect(recordsFor(fixture, 'doom_plan.plan_pointer_failed')).toHaveLength(1);
    });
  });

  it('gives the agent the plan as edited in the cockpit, not the draft it wrote', async () => {
    // The save lands on disk from another process, so nothing tells this
    // extension the plan changed. Reading it back each turn is what makes an
    // edit take effect rather than sit in a file the agent never rereads.
    await withPiSession(async (sessionDirectory) => {
      const fixture = createExtensionFixture([], undefined, true, 'cockpit-session', {}, {});
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Cockpit plan\n\nthe draft step');
      const planPath = expectedPlanPath(sessionDirectory, 'cockpit-plan', fixture);

      fs.writeFileSync(planPath, '# Cockpit plan\n\nthe reader corrected this step');
      const prompt = (await fixture.handler('before_agent_start')({ systemPrompt: 'base' }, fixture.ctx)) as {
        systemPrompt: string;
      };

      expect(prompt.systemPrompt).toContain('the reader corrected this step');
      expect(prompt.systemPrompt).not.toContain('the draft step');
    });
  });

  it('falls back to the written plan when the file has gone, rather than dropping it', async () => {
    await withPiSession(async (sessionDirectory) => {
      const fixture = createExtensionFixture([], undefined, true, 'cockpit-session', {}, {});
      await fixture.handler('session_start')({}, fixture.ctx);
      await fixture.invokeLeaderAction('plan.normal');
      await fixture.writePlan('# Cockpit plan\n\nthe draft step');

      fs.rmSync(expectedPlanPath(sessionDirectory, 'cockpit-plan', fixture));
      const prompt = (await fixture.handler('before_agent_start')({ systemPrompt: 'base' }, fixture.ctx)) as {
        systemPrompt: string;
      };

      expect(prompt.systemPrompt).toContain('the draft step');
    });
  });
});
