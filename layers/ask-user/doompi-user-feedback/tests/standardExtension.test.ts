import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, type MinorModeRecord } from '@agimon-ai/doompi-extension-contracts/mode';
import {
  DOOM_NARRATION_SERVICE,
  DOOM_VOICE_AUTO_MODE_ID,
  DOOM_VOICE_SOURCE,
} from '@agimon-ai/doompi-extension-contracts/narration';
import {
  type DoomToolSurfaceService,
  requireDoomToolSurface,
} from '@agimon-ai/doompi-extension-contracts/tool-surface';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionToolDependencies,
} from '../src/adapters/pi/askUserQuestionAdapter.js';
import { QuestionnaireCoordinator } from '../src/services/questionnaireCoordinator.js';
import type { QuestionnaireResult } from '../src/types/questionnaire.js';

const extensionMocks = vi.hoisted(() => {
  const handoffs: Array<{ handoff: ReturnType<typeof vi.fn> }> = [];
  return {
    handoffs,
    registerTool: vi.fn((_pi: unknown, _cordis: unknown, _dependencies: unknown) => undefined),
    runTuiQuestionnaire: vi.fn(async () => ({ answers: [], cancelled: false })),
    createVoiceHandoff: vi.fn((_modes: unknown, _narration: unknown) => {
      const handoff = { handoff: vi.fn(async () => undefined) };
      handoffs.push(handoff);
      return handoff;
    }),
  };
});

vi.mock('../src/adapters/pi/askUserQuestionAdapter.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapters/pi/askUserQuestionAdapter.ts')>()),
  registerAskUserQuestionTool: extensionMocks.registerTool,
}));
vi.mock('../src/adapters/doom/voiceQuestionHandoff.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapters/doom/voiceQuestionHandoff.ts')>()),
  createVoiceQuestionHandoff: extensionMocks.createVoiceHandoff,
}));
vi.mock('../src/tui/runQuestionnaire.ts', () => ({
  runTuiQuestionnaire: extensionMocks.runTuiQuestionnaire,
}));

import { userFeedbackExtension } from '../src/adapters/pi/extension.js';

type PiHandler = (event: unknown, context: ExtensionContext) => unknown;

function context(sessionId: string, hasUI = true): ExtensionContext {
  return {
    hasUI,
    mode: 'tui',
    sessionManager: { getSessionId: () => sessionId },
    ui: {},
  } as unknown as ExtensionContext;
}

interface HarnessOptions {
  tools?: string[];
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, PiHandler[]>();
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const tools = options.tools ? [...options.tools] : [];
  let activeTools = [...tools];
  const pi = {
    getAllTools: () => tools.map((name) => ({ name })),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    events: {
      emit(event: string, payload: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload);
      },
      on(event: string, handler: (payload: unknown) => void) {
        const listeners = eventHandlers.get(event) ?? new Set();
        listeners.add(handler);
        eventHandlers.set(event, listeners);
        return () => listeners.delete(handler);
      },
    },
    on: (event: string, handler: PiHandler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  } as unknown as ExtensionAPI;
  const dispatch = async (event: string, activeContext: ExtensionContext): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler({}, activeContext);
  };
  return { pi, handlers, dispatch, activeTools: () => [...activeTools] };
}

function voiceRecord(activation: 'active' | 'inactive'): MinorModeRecord {
  return {
    descriptor: {
      source: DOOM_VOICE_SOURCE,
      id: DOOM_VOICE_AUTO_MODE_ID,
      label: 'VOICE',
      description: 'Voice mode',
      order: 30,
      actions: [],
    },
    state: { activation, condition: 'ready', actions: [] },
    ownerGeneration: 'owner-1',
    registrationId: 'registration-1',
    stateRevision: 1,
  };
}

function createModeCatalog() {
  const listeners = new Set<() => void>();
  let activation: 'active' | 'inactive' = 'inactive';
  return {
    list: () => [voiceRecord(activation)],
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVoiceActive(value: boolean) {
      activation = value ? 'active' : 'inactive';
      for (const listener of listeners) listener();
    },
  };
}

async function installVoiceServices(pi: ExtensionAPI, catalog?: unknown): Promise<() => Promise<void>> {
  const connection = await connectDoomCordisHost(pi, '@test/user-feedback-voice-services');
  const providers = connection.root.plugin((cordis) => {
    cordis.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, (catalog ?? {}) as never);
    cordis.provide(DOOM_NARRATION_SERVICE, {} as never);
  });
  await providers;
  await vi.waitFor(() => expect(extensionMocks.createVoiceHandoff).toHaveBeenCalled());
  return async () => {
    await providers.dispose();
    await connection.dispose();
  };
}

function dependencies(): AskUserQuestionToolDependencies {
  return extensionMocks.registerTool.mock.calls.at(-1)?.[2] as AskUserQuestionToolDependencies;
}

/** Reads the session-scoped surface the host provides, so a test can model a rival owner. */
async function waitForToolSurface(pi: ExtensionAPI): Promise<DoomToolSurfaceService> {
  const connection = await connectDoomCordisHost(pi, '@test/user-feedback-tool-surface');
  try {
    return await vi.waitFor(() => requireDoomToolSurface(connection.root));
  } finally {
    await connection.dispose();
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  extensionMocks.handoffs.length = 0;
  extensionMocks.registerTool.mockImplementation(() => undefined);
  extensionMocks.runTuiQuestionnaire.mockImplementation(async () => ({ answers: [], cancelled: false }));
  extensionMocks.createVoiceHandoff.mockImplementation(() => {
    const handoff = { handoff: vi.fn(async () => undefined) };
    extensionMocks.handoffs.push(handoff);
    return handoff;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('standard User Feedback extension', () => {
  it('owns session resources and awaits idempotent package-local shutdown', async () => {
    const harness = createHarness();
    const activeContext = context('session-a');
    await userFeedbackExtension(harness.pi);
    const releaseVoiceServices = await installVoiceServices(harness.pi);
    await harness.dispatch('session_start', activeContext);

    expect(extensionMocks.createVoiceHandoff).toHaveBeenCalledOnce();
    const toolDependencies = dependencies();
    expect(toolDependencies.isActive?.(activeContext)).toBe(true);
    const completed: QuestionnaireResult = { answers: [], cancelled: false };
    await expect(
      toolDependencies.enqueue(async ({ reportProgress }) => {
        reportProgress(completed);
        return completed;
      }),
    ).resolves.toEqual(completed);
    const aborted = new AbortController();
    aborted.abort();
    const staleRunner = vi.fn(async () => completed);
    await expect(toolDependencies.enqueue(staleRunner, aborted.signal)).resolves.toEqual({
      answers: [],
      cancelled: true,
    });
    expect(staleRunner).not.toHaveBeenCalled();
    expect(toolDependencies.isActive?.(activeContext, aborted.signal)).toBe(false);
    await expect(toolDependencies.runTui(activeContext, { questions: [] }, 'active')).resolves.toEqual(completed);
    await expect(toolDependencies.tryVoice?.({ questions: [] })).resolves.toBeUndefined();
    expect(extensionMocks.handoffs[0]?.handoff).toHaveBeenCalledOnce();

    await harness.dispatch('session_shutdown', activeContext);
    await harness.dispatch('session_shutdown', activeContext);
    await harness.dispatch('session_start', activeContext);

    expect(extensionMocks.createVoiceHandoff).toHaveBeenCalledOnce();
    expect(dependencies().isActive?.(activeContext)).toBe(false);
    expect(dependencies().tryVoice?.({ questions: [] })).toBeUndefined();
    await releaseVoiceServices();
  });

  it('cancels and awaits pending work before activating a replacement context', async () => {
    const harness = createHarness();
    const firstContext = context('session-a');
    const nextContext = context('session-b');
    await userFeedbackExtension(harness.pi);
    const releaseVoiceServices = await installVoiceServices(harness.pi);
    await harness.dispatch('session_start', firstContext);
    const toolDependencies = dependencies();
    let resolvePresenter: ((result: QuestionnaireResult) => void) | undefined;
    let reportPresenter: ((result: QuestionnaireResult) => void) | undefined;
    let presenterAborted = false;
    const interaction = toolDependencies.enqueue(({ signal, reportProgress }) => {
      reportPresenter = reportProgress;
      signal.addEventListener('abort', () => {
        presenterAborted = true;
      });
      return new Promise<QuestionnaireResult>((resolve) => {
        resolvePresenter = resolve;
      });
    });

    let replacementFinished = false;
    const replacement = harness.dispatch('session_start', nextContext).then(() => {
      replacementFinished = true;
    });
    await vi.waitFor(() => expect(presenterAborted).toBe(true));

    expect(replacementFinished).toBe(false);
    expect(toolDependencies.isActive?.(firstContext)).toBe(false);
    expect(toolDependencies.isActive?.(nextContext)).toBe(false);
    reportPresenter?.({
      answers: [{ questionIndex: 0, question: 'Stale?', kind: 'option', answer: 'Ignore' }],
      cancelled: false,
    });
    await expect(toolDependencies.runTui(firstContext, { questions: [] }, 'stale')).resolves.toBeUndefined();

    resolvePresenter?.({ answers: [], cancelled: true });
    await expect(interaction).resolves.toEqual({ answers: [], cancelled: true });
    await replacement;

    expect(toolDependencies.isActive?.(firstContext)).toBe(false);
    expect(toolDependencies.isActive?.(nextContext)).toBe(true);
    expect(extensionMocks.createVoiceHandoff).toHaveBeenCalledOnce();
    await harness.dispatch('session_shutdown', nextContext);
    await releaseVoiceServices();
  });

  it('drops and recreates the voice binding with its Cordis providers', async () => {
    const harness = createHarness();
    const activeContext = context('session-a');
    await userFeedbackExtension(harness.pi);
    const releaseFirstProviders = await installVoiceServices(harness.pi);
    await harness.dispatch('session_start', activeContext);

    await expect(dependencies().tryVoice?.({ questions: [] })).resolves.toBeUndefined();
    expect(extensionMocks.handoffs[0]?.handoff).toHaveBeenCalledOnce();

    await releaseFirstProviders();
    expect(dependencies().tryVoice?.({ questions: [] })).toBeUndefined();

    const releaseSecondProviders = await installVoiceServices(harness.pi);
    expect(extensionMocks.createVoiceHandoff).toHaveBeenCalledTimes(2);
    await expect(dependencies().tryVoice?.({ questions: [] })).resolves.toBeUndefined();
    expect(extensionMocks.handoffs[1]?.handoff).toHaveBeenCalledOnce();

    await harness.dispatch('session_shutdown', activeContext);
    await releaseSecondProviders();
  });

  it('awaits a cancelled presenter before completing shutdown', async () => {
    const harness = createHarness();
    const activeContext = context('session-a');
    await userFeedbackExtension(harness.pi);
    await harness.dispatch('session_start', activeContext);
    let resolvePresenter: ((result: QuestionnaireResult) => void) | undefined;
    let presenterAborted = false;
    const interaction = dependencies().enqueue(({ signal }) => {
      signal.addEventListener('abort', () => {
        presenterAborted = true;
      });
      return new Promise<QuestionnaireResult>((resolve) => {
        resolvePresenter = resolve;
      });
    });
    let shutdownFinished = false;
    const shutdown = harness.dispatch('session_shutdown', activeContext).then(() => {
      shutdownFinished = true;
    });
    await vi.waitFor(() => expect(presenterAborted).toBe(true));

    expect(shutdownFinished).toBe(false);

    resolvePresenter?.({ answers: [], cancelled: true });
    await expect(interaction).resolves.toEqual({ answers: [], cancelled: true });
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  it('creates a fresh root when the same Pi host activates the factory again', async () => {
    const harness = createHarness();
    const activeContext = context('session-a');
    await userFeedbackExtension(harness.pi);
    await harness.dispatch('session_start', activeContext);
    await harness.dispatch('session_shutdown', activeContext);

    await userFeedbackExtension(harness.pi);
    await harness.dispatch('session_start', activeContext);

    expect(extensionMocks.registerTool).toHaveBeenCalledTimes(2);
    expect(extensionMocks.createVoiceHandoff).not.toHaveBeenCalled();
    await harness.dispatch('session_shutdown', activeContext);
  });

  it('hides ask_user_question while autonomous voice is active and restores it after', async () => {
    const tools = ['read', ASK_USER_QUESTION_TOOL_NAME, 'bash'];
    const harness = createHarness({ tools });
    const catalog = createModeCatalog();
    const activeContext = context('session-a');
    await userFeedbackExtension(harness.pi);
    const releaseVoiceServices = await installVoiceServices(harness.pi, catalog);

    // The tool surface is session-scoped, so there is nothing to restrict before session start.
    catalog.setVoiceActive(true);
    expect(harness.activeTools()).toEqual(tools);

    await harness.dispatch('session_start', activeContext);
    await vi.waitFor(() => expect(harness.activeTools()).toEqual(['read', 'bash']));

    catalog.setVoiceActive(false);
    expect(harness.activeTools()).toEqual(tools);

    await harness.dispatch('session_shutdown', activeContext);
    await releaseVoiceServices();
  });

  it('leaves a tool another owner hid alone while restoring its own', async () => {
    const harness = createHarness({ tools: ['read', ASK_USER_QUESTION_TOOL_NAME, 'bash'] });
    const catalog = createModeCatalog();
    const activeContext = context('session-a');
    await userFeedbackExtension(harness.pi);
    const releaseVoiceServices = await installVoiceServices(harness.pi, catalog);
    await harness.dispatch('session_start', activeContext);
    const surface = await waitForToolSurface(harness.pi);
    const rival = surface.register({
      source: 'rival',
      restrict: (incoming) => incoming.filter((name) => name !== 'bash'),
    });

    catalog.setVoiceActive(true);
    await vi.waitFor(() => expect(harness.activeTools()).toEqual(['read']));

    catalog.setVoiceActive(false);
    expect(harness.activeTools()).toEqual(['read', ASK_USER_QUESTION_TOOL_NAME]);

    rival.dispose();
    await harness.dispatch('session_shutdown', activeContext);
    await releaseVoiceServices();
  });

  it('hides ask_user_question for an agent run without UI', async () => {
    const tools = ['read', ASK_USER_QUESTION_TOOL_NAME];
    const harness = createHarness({ tools });
    const activeContext = context('session-a');
    await userFeedbackExtension(harness.pi);
    await harness.dispatch('session_start', activeContext);

    await harness.dispatch('before_agent_start', context('session-a', false));
    await vi.waitFor(() => expect(harness.activeTools()).toEqual(['read']));

    await harness.dispatch('before_agent_start', activeContext);
    expect(harness.activeTools()).toEqual(tools);

    // A run belonging to another session must not move this session's surface.
    await harness.dispatch('before_agent_start', context('session-b', false));
    expect(harness.activeTools()).toEqual(tools);

    await harness.dispatch('session_shutdown', activeContext);
  });

  it('restores the tool when the runtime shuts down while voice is still active', async () => {
    const harness = createHarness({ tools: [ASK_USER_QUESTION_TOOL_NAME] });
    const catalog = createModeCatalog();
    const activeContext = context('session-a');
    await userFeedbackExtension(harness.pi);
    const releaseVoiceServices = await installVoiceServices(harness.pi, catalog);
    await harness.dispatch('session_start', activeContext);
    await waitForToolSurface(harness.pi);

    catalog.setVoiceActive(true);
    expect(harness.activeTools()).toEqual([]);

    await harness.dispatch('session_shutdown', activeContext);
    expect(harness.activeTools()).toEqual([ASK_USER_QUESTION_TOOL_NAME]);
    await releaseVoiceServices();
  });

  it('rolls back the Cordis runtime when installation fails partway through', async () => {
    const shutdown = vi.spyOn(QuestionnaireCoordinator.prototype, 'shutdown');
    extensionMocks.registerTool.mockImplementationOnce(() => {
      throw new Error('tool registration failed');
    });
    const harness = createHarness();

    await expect(userFeedbackExtension(harness.pi)).rejects.toThrow('tool registration failed');

    expect(shutdown).toHaveBeenCalledOnce();
    // The standalone host's fenced shutdown listener remains in Pi's table;
    // the failed feature itself never installs a shutdown listener.
    expect(harness.handlers.get('session_shutdown')).toHaveLength(1);
    await expect(harness.dispatch('session_shutdown', context('failed-session'))).resolves.toBeUndefined();
  });
});
