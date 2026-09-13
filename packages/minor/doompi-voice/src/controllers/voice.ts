import path from 'node:path';

import { globalDoomConfigPath, resolveVoiceConfig } from '@agimon-ai/doompi-config/config';
import { getHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import { DOOM_ASK_USER_BLOCKED_EVENT } from '@agimon-ai/doompi-core/ask-user';
import { DOOM_CORDIS_SESSION_SERVICE, requireDoomCordisSession } from '@agimon-ai/doompi-core/cordis-host';
import type { LeaderBinding } from '@agimon-ai/doompi-core/leader';
import {
  DOOM_NARRATION_SERVICE,
  type DoomNarrationService,
  isNarrationRequest,
} from '@agimon-ai/doompi-core/narration';
import { definePiTool, type PiEventHandlers, type PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';
import { type DoomToolRestriction } from '@agimon-ai/doompi-core/tool-surface';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-core/voice-reload-handoff';
import {
  DOOM_VOICE_AUTO_MODE_ID as AUTO_COMMAND_NAME,
  DOOM_VOICE_SOURCE as VOICE_SOURCE,
  DOOM_VOICE_TOOLS_SERVICE,
  VOICE_MODE_TOOL_NAMES,
  VOICE_NARRATE_TOOL_NAME,
} from '@agimon-ai/doompi-core/voice-tools';
import { piMinorModes } from '@agimon-ai/doompi-minor-mode';
import {
  defineMinorMode,
  type MinorModeOwner,
  type MinorModeOwnerActionContext,
  type MinorModeState,
} from '@agimon-ai/doompi-minor-mode';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { COMMAND_NAME } from '../constants/voice';
import {
  STATUS_KEY,
  AUTO_LEADER_DETAIL,
  AUTO_MODE_LABEL,
  INFO_NOTIFICATION,
  ERROR_NOTIFICATION,
  VOICE_GROUP_SEGMENT,
} from '../constants/voiceRuntime';
import {
  formatVoiceActivity,
  formatAutoCaptureActivity,
  type VoiceFooterContributionValue,
} from '../models/voiceActivity';
import { canRunVoice, voiceOwnershipState, voiceModeState } from '../models/voiceMode';
import type { AutonomousTurnNonceFactory } from '../services/autonomousTurn';
import {
  type IVoiceCommandCorrectionModelClient,
  type IVoiceCommandCorrector,
  type VoiceCommandCorrectionModelRequest,
  VoiceCommandCorrector,
} from '../services/commandCorrection';
import {
  type FallbackNarrationModelRequest,
  type IFallbackNarrationModelClient,
  type IVoiceNarrationCompactor,
  type IVoiceTurnFallbackNarrator,
  VoiceTurnFallbackNarrator,
} from '../services/fallbackNarration';
import type { NarrationPlaybackOutcome } from '../services/narration';
import { realtimeHostConnection, type RealtimeHost } from '../services/realtimeHost';
import { createRealtimeRuntime, type RealtimeSignInAttempt } from '../services/realtimeRuntime';
import {
  registerSessionVoiceOwnership,
  SessionVoiceOwnershipBridge,
  sessionVoiceOwnership,
  type VoiceOwnershipSessionHost,
  voiceOwnershipLabel,
} from '../services/sessionVoiceOwnership';
import {
  type IVoiceTranscriptAdmissionModelClient,
  type IVoiceTranscriptAdjudicator,
  type VoiceTranscriptAdmissionModelRequest,
  VoiceTranscriptAdjudicator,
} from '../services/transcriptAdmission';
import type { VoiceDeliveryIntent } from '../services/voiceDelivery';
import { createVoiceDependencies } from '../services/voiceDependencies';
import { createDoomVoiceToolsService, type VoiceToolSessionHandle } from '../services/voiceTools';
import { VoiceWorkerAutoCaptureController } from '../services/voiceWorkerAutoCaptureController';
import { type VoiceWorkerSessionClientFactory } from '../services/voiceWorkerSessionController';
import {
  type AutoCaptureActivationState,
  type AutoCaptureUi,
  type IClock,
  type IVoiceMediaHostConnection,
  type VoiceDependencies,
  type VoiceUi,
} from '../types';
import { VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS } from '../types/voiceOwnership';
import { LiveVoiceController } from './liveVoiceController';
import { createMinorModeVoiceTool, createVoiceMinorModeCatalog } from './minorModeCatalog';
import { isNarrationRuntimeActive, type NarrationToolRuntime, createNarrationTool } from './narrationTool';
import { buildRealtimeContext } from './realtimeContext';
import {
  createTransferVoiceToolLifecycle,
  transferVoiceToolRestriction,
  transferVoiceToolVisible,
} from './transferVoiceTool';
import { collectVoiceCommandContext } from './voiceCommandContext';
import { VoiceModeController } from './voiceModeController';
import { createVoiceToolFacades } from './voiceTools';

const TRANSFER_VOICE_SOURCE = `${VOICE_SOURCE}#transfer-voice`;

export { MlxWhisperAdapter, OpenAiWhisperAdapter, TranscriberRegistry, WhisperCppAdapter } from '../services/whisper';

interface VoiceSessionContextLike {
  sessionManager?: { getSessionId(): string };
}

/** The handoff tool has its own visibility clock, so it owns its own restriction. */

/**
 * Whether this session can run autonomous capture.
 *
 * Capture is not a property of the terminal. ffmpeg reads a system audio
 * device on the machine the agent process runs on, and that machine is the
 * same one whether the session is driven from a TUI or spawned by the cockpit
 * hub. What the mode actually needs from a session is somewhere to put its
 * indicator, its status line and its notices, which is what a UI-bearing
 * session provides and a truly headless one does not.
 */

/** Manual capture needs the same browser media ownership as autonomous capture. */

/** The leader half of the same indirection the footer uses across the adapter split. */
export interface VoiceLeaderContributionHandle {
  update(bindings: readonly LeaderBinding[]): void;
}

export interface VoiceFooterContributionHandle {
  update(value: VoiceFooterContributionValue | undefined): void;
  dispose(): void;
}

/**
 * The voice menu as it stands with autonomous capture on or off.
 *
 * `e` carries the mode the way every other minor mode publishes its toggle, and
 * the same command name serves both directions because the handler already
 * branches on the controller's state. `m` stays a one-shot action: dictating
 * once is not entering anything, so it never flips.
 */
export function voiceLeaderBindings(autoActive: boolean): LeaderBinding[] {
  return [
    {
      id: 'voice.toggle',
      path: [VOICE_GROUP_SEGMENT, { key: 'm', label: 'manual', detail: 'one-shot manual dictation' }],
      command: { name: COMMAND_NAME },
    },
    {
      id: 'voice.auto-toggle',
      path: [
        VOICE_GROUP_SEGMENT,
        autoActive
          ? { key: 'e', label: 'exit', detail: 'stop autonomous capture', tone: 'exit' }
          : { key: 'e', label: 'enter', detail: AUTO_LEADER_DETAIL },
      ],
      command: { name: AUTO_COMMAND_NAME },
    },
  ];
}

function createVoiceUi(context: ExtensionContext, footer: VoiceFooterContributionHandle): VoiceUi {
  return {
    notify: (message, level) => context.ui.notify(message, level),
    setStatus: (key, value) => context.ui.setStatus(key, value),
    setIndicator: (update) => footer.update(update ? formatVoiceActivity(update).footer : undefined),
    getEditorText: () => context.ui.getEditorText(),
    setEditorText: (text) => context.ui.setEditorText(text),
  };
}

function createAutoCaptureUi(context: ExtensionContext, footer: VoiceFooterContributionHandle): AutoCaptureUi {
  return {
    notify: (message, level) => context.ui.notify(message, level),
    setStatus: (value) => context.ui.setStatus(STATUS_KEY, value),
    setIndicator: (state) => footer.update(state ? formatAutoCaptureActivity(state).footer : undefined),
  };
}

export type AutoCaptureDeliveryIntent = VoiceDeliveryIntent;

export function deliverAutoCaptureInput(
  pi: Pick<ExtensionAPI, 'sendUserMessage'>,
  context: Pick<ExtensionContext, 'isIdle'>,
  text: string,
  intent: AutoCaptureDeliveryIntent = 'immediate',
): void {
  if (intent === 'queuedFollowUp') {
    pi.sendUserMessage(text, { deliverAs: 'followUp' });
    return;
  }
  if (context.isIdle()) {
    pi.sendUserMessage(text);
    return;
  }
  pi.sendUserMessage(text, { deliverAs: 'steer' });
}

export interface AutoCapturePiEventController {
  askUserBlocked(blocked: boolean): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface VoiceNarrationServiceBinding {
  readonly generation: string;
  readonly signal: AbortSignal;
  isCurrentSession(): boolean;
}

export function createVoiceNarrationService(
  controller: Pick<VoiceWorkerAutoCaptureController, 'narrateExternal'>,
  binding: VoiceNarrationServiceBinding,
): DoomNarrationService {
  const service: DoomNarrationService = {
    generation: binding.generation,
    async request(request) {
      if (!isNarrationRequest(request)) throw new Error('Invalid narration request.');
      if (binding.signal.aborted || !binding.isCurrentSession()) return;
      await controller.narrateExternal(request.text, binding.signal);
    },
  };
  return Object.freeze(service);
}

export function registerSessionVoiceNarrationService(
  cordis: Context,
  controller: Pick<VoiceWorkerAutoCaptureController, 'narrateExternal'>,
  runtimeProvider: () => NarrationToolRuntime | undefined,
): void {
  cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
    const session = requireDoomCordisSession(sessionContext);
    const sessionAbort = new AbortController();
    let mounted = true;
    sessionContext.provide(
      DOOM_NARRATION_SERVICE,
      createVoiceNarrationService(controller, {
        generation: `${session.generation}:voice-narration`,
        signal: sessionAbort.signal,
        isCurrentSession: () => mounted && isNarrationRuntimeActive(runtimeProvider(), session.context),
      }),
    );
    return () => {
      mounted = false;
      sessionAbort.abort();
    };
  });
}

export function registerAutoCaptureCordisEventHandlers(
  cordis: Context,
  controller: AutoCapturePiEventController,
): () => void {
  return cordis.on(DOOM_ASK_USER_BLOCKED_EVENT, (event) => controller.askUserBlocked(event.active));
}

export interface VoiceTurnFallbackRuntime {
  activeGeneration(context: ExtensionContext): number | undefined;
  narrate(finalResponse: string, signal?: AbortSignal): Promise<NarrationPlaybackOutcome>;
}

interface VoiceTurnFallbackState {
  sessionId: string;
  sessionManager: ExtensionContext['sessionManager'];
  activationId: number;
  narrateAttempted: boolean;
  finalResponse?: string;
}

function sameFallbackTurn(state: VoiceTurnFallbackState, context: ExtensionContext): boolean {
  return (
    state.sessionManager === context.sessionManager &&
    state.sessionId === (context as unknown as VoiceSessionContextLike).sessionManager?.getSessionId()
  );
}

export function extractTerminalAssistantText(message: unknown): string | undefined {
  if (
    !isRecord(message) ||
    message.role !== 'assistant' ||
    message.stopReason === 'toolUse' ||
    !Array.isArray(message.content)
  )
    return undefined;
  const text: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'toolCall') return undefined;
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
  }
  return text.join('').trim() || undefined;
}

export function createVoiceTurnFallback(runtime: VoiceTurnFallbackRuntime): {
  events: PiEventHandlers;
  dispose(): void;
} {
  let turn: VoiceTurnFallbackState | undefined;
  let active = true;

  return {
    events: {
      before_agent_start: (_event, context) => {
        if (!active) return;
        const activationId = runtime.activeGeneration(context);
        const sessionId = (context as unknown as VoiceSessionContextLike).sessionManager?.getSessionId();
        turn =
          activationId !== undefined && sessionId
            ? {
                sessionId,
                sessionManager: context.sessionManager,
                activationId,
                narrateAttempted: false,
              }
            : undefined;
      },
      tool_execution_start: (event, context) => {
        if (!active) return;
        if (event.toolName === VOICE_NARRATE_TOOL_NAME && turn && sameFallbackTurn(turn, context)) {
          turn.narrateAttempted = true;
        }
      },
      turn_end: (event, context) => {
        if (!active || !turn || !sameFallbackTurn(turn, context)) return;
        const finalResponse = extractTerminalAssistantText(event.message);
        if (finalResponse) turn.finalResponse = finalResponse;
      },
      agent_settled: async (_event, context) => {
        if (!active) return;
        const settled = turn;
        turn = undefined;
        if (!settled || settled.narrateAttempted || !settled.finalResponse || !sameFallbackTurn(settled, context))
          return;
        if (runtime.activeGeneration(context) !== settled.activationId) return;
        await runtime.narrate(settled.finalResponse, context.signal);
      },
    },
    dispose() {
      active = false;
      turn = undefined;
    },
  };
}

export function resolveVoiceCommandCorrector(reference: string, context: ExtensionContext): IVoiceCommandCorrector {
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1)
    throw new Error('Voice command correction model must use provider/model-id form');
  const provider = reference.slice(0, separator);
  const modelId = reference.slice(separator + 1);
  const model = context.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Voice command correction model is not registered: ${reference}`);
  if (!context.modelRegistry.hasConfiguredAuth(model))
    throw new Error(`Voice command correction model has no configured authentication: ${reference}`);

  const modelClient: IVoiceCommandCorrectionModelClient = {
    complete: async (request: VoiceCommandCorrectionModelRequest): Promise<string> => {
      const response = await context.modelRegistry.complete(
        model,
        {
          systemPrompt: request.systemPrompt,
          messages: [{ role: 'user', content: request.input, timestamp: Date.now() }],
        },
        {
          signal: request.signal,
          maxTokens: request.maxTokens,
          cacheRetention: request.cacheRetention,
          reasoningEffort: 'none',
          maxRetries: 0,
        },
      );
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error(response.errorMessage ?? `Voice command correction model stopped with ${response.stopReason}`);
      }
      return response.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text)
        .join('')
        .trim();
    },
  };
  return new VoiceCommandCorrector(modelClient);
}

export function resolveVoiceTranscriptAdjudicator(
  reference: string,
  context: ExtensionContext,
  clock: IClock,
): IVoiceTranscriptAdjudicator {
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1)
    throw new Error('Voice transcript admission model must use provider/model-id form');
  const provider = reference.slice(0, separator);
  const modelId = reference.slice(separator + 1);
  const model = context.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Voice transcript admission model is not registered: ${reference}`);
  if (!context.modelRegistry.hasConfiguredAuth(model))
    throw new Error(`Voice transcript admission model has no configured authentication: ${reference}`);

  const modelClient: IVoiceTranscriptAdmissionModelClient = {
    complete: async (request: VoiceTranscriptAdmissionModelRequest): Promise<string> => {
      const response = await context.modelRegistry.complete(
        model,
        {
          systemPrompt: request.systemPrompt,
          messages: [{ role: 'user', content: request.input, timestamp: Date.now() }],
        },
        {
          signal: request.signal,
          maxTokens: request.maxTokens,
          cacheRetention: request.cacheRetention,
          reasoningEffort: 'none',
          maxRetries: 0,
        },
      );
      if (response.stopReason === 'error' || response.stopReason === 'aborted')
        throw new Error(
          response.errorMessage ?? `Voice transcript admission model stopped with ${response.stopReason}`,
        );
      return response.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text)
        .join('')
        .trim();
    },
  };
  return new VoiceTranscriptAdjudicator(modelClient, clock);
}
export function resolveVoiceFallbackNarrator(
  reference: string,
  context: ExtensionContext,
): IVoiceTurnFallbackNarrator & IVoiceNarrationCompactor {
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1)
    throw new Error('Voice fallback narration model must use provider/model-id form');
  const provider = reference.slice(0, separator);
  const modelId = reference.slice(separator + 1);
  const model = context.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Voice fallback narration model is not registered: ${reference}`);
  if (!context.modelRegistry.hasConfiguredAuth(model))
    throw new Error(`Voice fallback narration model has no configured authentication: ${reference}`);

  const modelClient: IFallbackNarrationModelClient = {
    complete: async (request: FallbackNarrationModelRequest): Promise<string> => {
      const response = await context.modelRegistry.complete(
        model,
        {
          systemPrompt: request.systemPrompt,
          messages: [{ role: 'user', content: request.input, timestamp: Date.now() }],
        },
        {
          signal: request.signal,
          maxTokens: request.maxTokens,
          cacheRetention: request.cacheRetention,
          reasoningEffort: 'none',
          maxRetries: 0,
        },
      );
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error(response.errorMessage ?? `Voice fallback narration model stopped with ${response.stopReason}`);
      }
      return response.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text)
        .join('')
        .trim();
    },
  };
  return new VoiceTurnFallbackNarrator(modelClient);
}

/**
 * Shared Doom config owns `voice:`; the package-scoped file is the fallback for
 * standalone installs that have no Doom config.
 */

/**
 * Compose the voice runtime.
 *
 * Construction order is the dependency order, so the graph reads top to bottom
 * and a cycle is a compile error rather than a resolution failure at runtime.
 */

/**
 * Hides the Voice-owned tools whenever they cannot be used.
 *
 * They are registered for the whole session, so the surface would otherwise
 * offer them while autonomous voice is off. The all-or-nothing gate on
 * `available` is deliberate: a partially registered facade is not usable, so
 * the model should not see any part of it.
 */
export function voiceToolRestriction(enabled: boolean, narrationEnabled = true): DoomToolRestriction {
  const owned = new Set<string>(VOICE_MODE_TOOL_NAMES);
  return (incoming, available) => {
    const visible = enabled && VOICE_MODE_TOOL_NAMES.every((name) => available.includes(name));
    return incoming.filter((name) => {
      if (!owned.has(name)) return true;
      return visible && (narrationEnabled || name !== VOICE_NARRATE_TOOL_NAME);
    });
  };
}

export interface VoiceExtensionOptions {
  clientMedia?: IVoiceMediaHostConnection;
  ownershipHost?: VoiceOwnershipSessionHost;
  footer?: VoiceFooterContributionHandle;
  leader?: VoiceLeaderContributionHandle;
  dependencies?: VoiceDependencies;
  autoClientFactory?: VoiceWorkerSessionClientFactory;
  identityNonceFactory?: AutonomousTurnNonceFactory;
  waitUntilConfigured?: (context: ExtensionContext, signal?: AbortSignal) => Promise<void>;
  liveHost?: RealtimeHost;
  liveSignIn?: (signal: AbortSignal) => Promise<RealtimeSignInAttempt>;
}

export function createVoiceRuntime(
  pi: ExtensionAPI,
  options: VoiceExtensionOptions = {},
): PiPluginContributions<VoiceExtensionOptions> {
  const dependencies = options.dependencies ?? createVoiceDependencies({ clientMedia: options.clientMedia });
  const ownershipHost = options.ownershipHost;
  const controller = dependencies.sessionController;
  const configs = dependencies.configs;
  const footer = options.footer ?? { update: () => undefined, dispose: () => undefined };
  const leader = options.leader ?? { update: () => undefined };
  let lastUi: VoiceUi | undefined;
  let lastAutoUi: AutoCaptureUi | undefined;
  let activeContext: ExtensionContext | undefined;
  const voiceTools = createDoomVoiceToolsService<ExtensionContext>(`${VOICE_SOURCE}:${crypto.randomUUID()}`);
  const reloadHandoffs = createVoiceReloadHandoffStore({
    now: () => Date.now(),
    createToken: () => crypto.randomUUID(),
  });

  let voiceToolSession: VoiceToolSessionHandle<ExtensionContext> | undefined;
  let voiceToolCatalogSubscription: (() => void) | undefined;
  let narrationToolRuntime: NarrationToolRuntime | undefined;
  let active = true;
  let sessionGeneration = 0;

  let voiceToolsVisible = false;
  let narrationToolVisible = true;
  const restrictionListeners = new Set<() => void>();
  let transferRestriction = transferVoiceToolRestriction(transferVoiceToolVisible());
  const currentVoiceRestriction = (): DoomToolRestriction =>
    voiceToolRestriction(voiceToolsVisible, narrationToolVisible);

  let transferVoiceTool: ReturnType<typeof createTransferVoiceToolLifecycle> | undefined;
  const waitUntilSelectedModeReady = async (context: ExtensionContext, signal?: AbortSignal): Promise<void> => {
    if (autoController.selectedMode !== 'live') await options.waitUntilConfigured?.(context, signal);
  };
  let voiceToolFacades: ReturnType<typeof createVoiceToolFacades> | undefined;
  const modeCatalog = createVoiceMinorModeCatalog();

  const modeToolContribution = voiceTools.register(createMinorModeVoiceTool(modeCatalog));

  let mode: MinorModeOwner<MinorModeOwnerActionContext<ExtensionContext>>;
  let modeState = voiceModeState('disabled');
  const publishMode = (state: MinorModeState): void => {
    modeState = state;
    mode?.publish();
  };
  const reconcileVoiceTools = (state: AutoCaptureActivationState): void => {
    const contextSessionId = (
      activeContext as unknown as VoiceSessionContextLike | undefined
    )?.sessionManager?.getSessionId();
    const enabled =
      state === 'active' &&
      activeContext?.hasUI === true &&
      voiceToolSession !== undefined &&
      contextSessionId === voiceToolSession.sessionId;
    voiceToolSession?.setActive(enabled);
    voiceToolsVisible = enabled;
    narrationToolVisible = autoController.selectedMode !== 'live';
    restrictionListeners.forEach((listener) => listener());
    voiceToolFacades?.refresh();
  };
  const configuredMode = (): 'legacy' | 'live' =>
    configs.load(process.env.PI_PROJECT_ROOT ?? process.cwd()).voice?.mode === 'live' ? 'live' : 'legacy';
  const publishActivation = (state: AutoCaptureActivationState): void => {
    if (!active) return;
    reconcileVoiceTools(state);
    publishMode(voiceModeState(state, canRunVoice(activeContext)));
    leader.update(voiceLeaderBindings(state !== 'disabled'));
  };
  const legacyController = new VoiceWorkerAutoCaptureController({
    loadConfig: () => {
      const root = process.env.PI_PROJECT_ROOT ?? process.cwd();
      const loaded = configs.load(root).voice;
      if (!loaded) throw new Error('Voice is not configured in the Pi agent configuration.');
      // Read on every enable(), so the profile's voice lands on the next
      // activation. A profile switch reloads the session, which is what makes
      // that soon enough to feel immediate.
      return resolveVoiceConfig(loaded, getHarnessState().profileVoice);
    },
    resolveCommandCorrector: async (reference) => {
      if (!activeContext) throw new Error('No autonomous voice session is active');
      return resolveVoiceCommandCorrector(reference, activeContext);
    },
    resolveTranscriptAdjudicator: async (reference) => {
      if (!activeContext) throw new Error('No autonomous voice session is active');
      return resolveVoiceTranscriptAdjudicator(reference, activeContext, dependencies.clock);
    },
    resolveFallbackNarrator: async (reference) => {
      if (!activeContext) throw new Error('No autonomous voice session is active');
      return resolveVoiceFallbackNarrator(reference, activeContext);
    },
    tts: dependencies.tts,
    clock: dependencies.clock,
    deliver: (text, intent) => {
      if (!activeContext) throw new Error('No autonomous voice session is active');
      deliverAutoCaptureInput(pi, activeContext, text, intent);
    },
    manualState: () => controller.state,
    commandContext: () =>
      activeContext
        ? collectVoiceCommandContext(activeContext.sessionManager.getBranch(), modeCatalog.records())
        : undefined,
    onActivationStateChange: publishActivation,
    ...(options.autoClientFactory ? { clientFactory: options.autoClientFactory } : {}),
    ...(options.identityNonceFactory ? { identityNonceFactory: options.identityNonceFactory } : {}),
  });
  const liveController = new LiveVoiceController({
    host: realtimeHostConnection(options.liveHost),
    clock: dependencies.clock,
    manualState: () => controller.state,
    isBusy: () => activeContext?.isIdle() === false,
    contextText: () =>
      activeContext
        ? buildRealtimeContext(activeContext.sessionManager.getBranch(), { busy: !activeContext.isIdle() })
        : '',
    send: (text, intent) => {
      if (!activeContext) throw new Error('No live voice session is active.');
      deliverAutoCaptureInput(pi, activeContext, text, intent === 'follow-up' ? 'queuedFollowUp' : 'immediate');
    },
    onActivationStateChange: publishActivation,
  });
  const autoController = new VoiceModeController({
    legacy: legacyController,
    live: liveController,
    getMode: configuredMode,
  });
  let signInAttempt: RealtimeSignInAttempt | undefined;
  let signInController: AbortController | undefined;
  const cancelSignIn = (): void => {
    signInController?.abort();
    signInAttempt?.cancel();
    signInAttempt = undefined;
  };

  const signIn = async (ui: AutoCaptureUi): Promise<void> => {
    cancelSignIn();
    const cancellation = new AbortController();
    signInController = cancellation;
    try {
      const attempt = await (
        options.liveSignIn ??
        ((signal: AbortSignal) =>
          createRealtimeRuntime({ stateDirectory: path.dirname(globalDoomConfigPath()) }).signIn(signal))
      )(cancellation.signal);
      if (cancellation.signal.aborted || !active) {
        attempt.cancel();
        return;
      }
      signInAttempt = attempt;
      ui.notify(
        `Open this URL in a browser on the DoomPi host to sign in. Microphone capture stays off:\n${attempt.authorizationUrl}`,
        'info',
      );
      void attempt.completion
        .then(
          () => {
            if (!cancellation.signal.aborted && active)
              ui.notify('Subscription sign-in completed. Activate live voice explicitly when ready.', 'info');
          },
          () => {
            if (!cancellation.signal.aborted && active)
              ui.notify('Subscription sign-in failed or timed out. Run /voice-auto login to try again.', 'error');
          },
        )
        .finally(() => {
          if (signInAttempt === attempt) signInAttempt = undefined;
        });
    } catch {
      if (!cancellation.signal.aborted && active)
        ui.notify('Could not start subscription sign-in. Check that localhost port 1455 is available.', 'error');
    }
  };
  const requestAutonomousActivation = async (ui: AutoCaptureUi, context: ExtensionContext): Promise<void> => {
    if (ownershipHost === undefined) {
      await autoController.activate(ui);
      return;
    }
    const request = sessionVoiceOwnership.requestActivation();
    if (request === undefined) throw new Error('Autonomous voice activation is unavailable for this server session.');
    const bridge = ownershipBridge;
    if (bridge === undefined) {
      sessionVoiceOwnership.clearActivationRequest(request.requestId);
      throw new Error('Autonomous voice ownership is not connected for this server session.');
    }
    ui.setIndicator('processing');
    ui.setStatus('voice auto: starting');
    publishMode(voiceModeState('starting', canRunVoice(context)));
    try {
      await bridge.synchronize();
    } catch (error) {
      sessionVoiceOwnership.clearActivationRequest(request.requestId);
      ui.setIndicator(undefined);
      ui.setStatus(undefined);
      publishMode(voiceModeState('disabled', canRunVoice(context)));
      throw error;
    }
    dependencies.clock.setTimeout(() => {
      if (sessionVoiceOwnership.snapshot().activation?.requestId !== request.requestId) return;
      sessionVoiceOwnership.clearActivationRequest(request.requestId);
      ui.setIndicator(undefined);
      ui.setStatus(undefined);
      publishMode(voiceModeState('disabled', canRunVoice(context)));
      ui.notify('Autonomous voice activation timed out while waiting for session ownership.', 'error');
    }, VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS);
  };

  mode = defineMinorMode<void, MinorModeOwnerActionContext<ExtensionContext>>({
    descriptor: {
      source: VOICE_SOURCE,
      id: AUTO_COMMAND_NAME,
      label: AUTO_MODE_LABEL,
      description: 'Autonomous voice capture with command correction and primary-agent narration.',
      order: 30,
      actions: [
        {
          id: 'activate',
          label: 'Autonomous voice',
          description: 'Start continuous capture with command correction and primary-agent narration.',
          contexts: ['tui', 'headless'],
          parameters: [],
        },
        {
          id: 'manual',
          label: 'Manual voice',
          description: 'Start one-shot dictation, then stop it to fill the current prompt.',
          contexts: ['tui'],
          parameters: [],
        },
        {
          id: 'deactivate',
          label: 'Stop autonomous voice',
          description: 'Stop autonomous voice capture.',
          contexts: ['tui', 'headless'],
          parameters: [],
        },
      ],
    },
    state: () => modeState,
    async handleAction(_runtime, actionId, _argumentsValue, execution) {
      if (!active) throw new Error('Voice runtime is disposed.');
      if (actionId === 'manual' || (actionId === 'activate' && configuredMode() !== 'live'))
        await options.waitUntilConfigured?.(execution.context);
      if (!active) throw new Error('Voice runtime is disposed.');
      activeContext = execution.context;
      const ui = createAutoCaptureUi(execution.context, footer);
      lastAutoUi = ui;
      if (actionId === 'activate') {
        await requestAutonomousActivation(ui, execution.context);
        return { message: 'Autonomous voice activation requested through the session hub.' };
      }
      if (actionId === 'manual') {
        if (autoController.state !== 'disabled') throw new Error('End voice mode before using manual dictation.');
        lastUi = createVoiceUi(execution.context, footer);
        await controller.toggle(lastUi);
        return { message: 'Manual voice recording started. Stop it to fill the current prompt.' };
      }
      if (actionId === 'deactivate') {
        await autoController.deactivate(ui);
        return { message: 'Autonomous voice deactivation requested.' };
      }
      throw new Error(`Unknown autonomous voice action: ${actionId}`);
    },
  }).createOwner(undefined);
  let ownershipDispose: (() => void) | undefined;
  let ownershipBridge: SessionVoiceOwnershipBridge | undefined;

  const fallback = createVoiceTurnFallback({
    activeGeneration: (context) =>
      active && autoController.selectedMode !== 'live' && isNarrationRuntimeActive(narrationToolRuntime, context)
        ? autoController.activationId
        : undefined,
    narrate: (finalResponse, signal) => autoController.narrateFallback(finalResponse, signal),
  });
  transferVoiceTool = createTransferVoiceToolLifecycle((restrict) => {
    transferRestriction = restrict;
    restrictionListeners.forEach((listener) => listener());
  });
  voiceToolFacades = createVoiceToolFacades(() => voiceToolSession, waitUntilSelectedModeReady);
  const narrationTool = definePiTool(createNarrationTool(() => narrationToolRuntime, waitUntilSelectedModeReady));
  return {
    services: [
      {
        apply(cordis: Context) {
          modeCatalog.apply(cordis);
          cordis.provide(DOOM_VOICE_TOOLS_SERVICE, voiceTools);
          cordis.effect(() => () => voiceTools.dispose());
          cordis.effect(() => () => {
            active = false;
            sessionGeneration += 1;
            activeContext = undefined;
            narrationToolRuntime = undefined;
          });
          cordis.effect(() => () => modeCatalog.dispose());
          cordis.effect(() => () => modeToolContribution.dispose());
          cordis.effect(() => cancelSignIn);
          registerSessionVoiceNarrationService(cordis, autoController, () => narrationToolRuntime);
          cordis.effect(() => () => {
            ownershipBridge?.stop();
            ownershipDispose?.();
          });
          const disposeAutoCaptureEvents = registerAutoCaptureCordisEventHandlers(cordis, autoController);
          cordis.effect(() => disposeAutoCaptureEvents);
        },
      },
      piMinorModes([mode]),
    ],

    toolRestrictions: [
      {
        source: VOICE_SOURCE,
        restrict: (incoming, context) => currentVoiceRestriction()(incoming, context),
        subscribe(listener) {
          restrictionListeners.add(listener);
          return () => {
            restrictionListeners.delete(listener);
          };
        },
      },
      {
        source: TRANSFER_VOICE_SOURCE,
        restrict: (incoming, context) => transferRestriction(incoming, context),
        subscribe(listener) {
          restrictionListeners.add(listener);
          return () => {
            restrictionListeners.delete(listener);
          };
        },
      },
    ],
    tools: {
      snapshot: () => [...voiceToolFacades!.snapshot(), ...transferVoiceTool!.snapshot(), narrationTool],
      subscribe(listener) {
        const facades = voiceToolFacades!.subscribe(listener);
        const transfer = transferVoiceTool!.subscribe(listener);
        return () => {
          facades();
          transfer();
        };
      },
    },
    commands: [
      [
        COMMAND_NAME,
        {
          description: 'Toggle one-shot manual voice dictation',
          handler: async (_args, ctx) => {
            if (!active || !ctx.hasUI) return;
            await options.waitUntilConfigured?.(ctx);
            if (!active) return;
            lastUi = createVoiceUi(ctx, footer);
            if (autoController.state !== 'disabled') {
              lastUi.notify('Disable autonomous voice before using manual voice', INFO_NOTIFICATION);
              return;
            }
            await controller.toggle(lastUi);
          },
        },
      ],
      [
        AUTO_COMMAND_NAME,
        {
          description: 'Toggle voice, mute/unmute, end, or use live subscription login and interruption',
          handler: async (args, ctx) => {
            if (!active || !ctx.hasUI) return;
            const action = args.trim().toLowerCase();
            if (action === 'login') {
              await signIn(createAutoCaptureUi(ctx, footer));
              return;
            }
            if (action === 'login-cancel') {
              cancelSignIn();
              return;
            }
            if (!action && autoController.state === 'disabled' && configuredMode() !== 'live')
              await options.waitUntilConfigured?.(ctx);
            if (!active) return;
            activeContext = ctx;
            lastAutoUi = createAutoCaptureUi(ctx, footer);
            const microphoneAction = args.trim().toLowerCase();
            if (microphoneAction === 'mute' || microphoneAction === 'unmute') {
              if (autoController.state !== 'active') {
                lastAutoUi.notify('Autonomous voice is not active.', INFO_NOTIFICATION);
                return;
              }
              autoController.setMicrophoneMuted(microphoneAction === 'mute');
              return;
            }
            if (microphoneAction === 'end') {
              await autoController.deactivate(lastAutoUi);
              return;
            }
            if (microphoneAction === 'interrupt') {
              if (autoController.selectedMode !== 'live' || autoController.state !== 'active')
                lastAutoUi.notify('Live voice is not active.', INFO_NOTIFICATION);
              else autoController.interruptSpeech();
              return;
            }
            if (microphoneAction) {
              lastAutoUi.notify('Usage: /voice-auto [mute|unmute|end|interrupt|login|login-cancel]', INFO_NOTIFICATION);
              return;
            }
            if (autoController.state === 'disabled') await requestAutonomousActivation(lastAutoUi, ctx);
            else await autoController.deactivate(lastAutoUi);
          },
        },
      ],
    ],
    events: {
      ...fallback.events,
      session_start: async (event, ctx) => {
        if (!active) return;
        cancelSignIn();
        transferVoiceTool?.sessionStarted();
        const ownGeneration = ++sessionGeneration;
        const reason = (event as { reason?: string }).reason;
        if (autoController.state !== 'disabled') {
          await autoController.deactivate(lastAutoUi ?? createAutoCaptureUi(ctx, footer));
        }
        if (!active || ownGeneration !== sessionGeneration) return;
        activeContext = ctx;
        lastUi = undefined;
        lastAutoUi = undefined;
        narrationToolRuntime = undefined;
        voiceToolCatalogSubscription?.();
        voiceToolCatalogSubscription = undefined;
        voiceToolSession?.setActive(false);
        voiceToolSession?.dispose();
        voiceToolSession = undefined;

        ownershipBridge?.stop();
        ownershipBridge = undefined;
        ownershipDispose?.();
        ownershipDispose = undefined;
        const sessionId = (ctx as unknown as VoiceSessionContextLike).sessionManager?.getSessionId();
        let reloadHandoff = false;
        if (sessionId) {
          try {
            const session = voiceTools.bindSession(sessionId, ctx);
            voiceToolSession = session;
            voiceToolCatalogSubscription = session.subscribe(() => voiceToolFacades?.refresh());
            narrationToolRuntime = { context: ctx, session, controller: autoController };
            reloadHandoff = reason === 'reload' && reloadHandoffs.consume(sessionId) !== undefined;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (ctx.hasUI) ctx.ui.notify(`Voice capability host unavailable: ${message}`, ERROR_NOTIFICATION);
          }
        }
        reconcileVoiceTools('disabled');
        // Published before the UI bail below, and for every session rather than
        // only the ones that carry a UI. Registration cannot know the session, so
        // its default stands until this runs, and that default says the mode
        // cannot run: without this a cockpit session, which can run it perfectly
        // well, would keep reporting otherwise for the life of the session.
        publishMode(voiceModeState('disabled', canRunVoice(ctx)));
        if (!ctx.hasUI) return;
        ownershipDispose = registerSessionVoiceOwnership({
          label: () => pi.getSessionName() ?? voiceOwnershipLabel(process.env.PI_PROJECT_ROOT ?? process.cwd()),
          eligible: true,
          controller: {
            get state() {
              return voiceOwnershipState(controller.state, autoController.state);
            },
            get activationError() {
              return autoController.activationError;
            },
            activateVoice: () => autoController.activate(lastAutoUi ?? createAutoCaptureUi(ctx, footer)),
            deactivateVoice: async () => {
              const ui = lastAutoUi ?? createAutoCaptureUi(ctx, footer);
              const alreadyDisabled = autoController.state === 'disabled';
              await autoController.deactivate(ui);
              if (alreadyDisabled) {
                ui.setIndicator(undefined);
                ui.setStatus(undefined);
                publishMode(voiceModeState('disabled', canRunVoice(activeContext)));
              }
            },
          },
        });
        lastUi = createVoiceUi(ctx, footer);
        lastAutoUi = createAutoCaptureUi(ctx, footer);
        lastUi.setIndicator(undefined);
        lastUi.setStatus(STATUS_KEY, undefined);
        if (ownershipHost !== undefined) {
          ownershipBridge = new SessionVoiceOwnershipBridge(sessionVoiceOwnership, ownershipHost, dependencies.clock);
          ownershipBridge.start();
        }
        if (reloadHandoff && lastAutoUi && configuredMode() !== 'live') {
          if (ownershipHost === undefined) await autoController.activate(lastAutoUi);
          else await requestAutonomousActivation(lastAutoUi, ctx);
        }
      },
      before_agent_start: async (event, context) => {
        ((_event, ctx) => {
          if (!active) return;
          activeContext = ctx;
          const sessionId = (ctx as unknown as VoiceSessionContextLike).sessionManager?.getSessionId();
          narrationToolRuntime =
            autoController.selectedMode !== 'live' && voiceToolSession && sessionId === voiceToolSession.sessionId
              ? { context: ctx, session: voiceToolSession, controller: autoController }
              : undefined;
          reconcileVoiceTools(autoController.state);
        })(event, context);
        await fallback.events.before_agent_start?.(event, context);
      },
      agent_settled: async (event, context) => {
        await (async (_event, ctx) => {
          if (!active || autoController.selectedMode !== 'live' || liveController.state !== 'active') return;
          if (ctx.sessionManager !== activeContext?.sessionManager) return;
          const lastMessage = ctx.sessionManager.getBranch().findLast((entry) => entry.type === 'message');
          if (!lastMessage || lastMessage.type !== 'message') return;
          const message = lastMessage.message;
          const text =
            message.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted'
              ? extractTerminalAssistantText(message)
              : undefined;
          await liveController.publishAgentResult(lastMessage.id, text);
        })(event, context);
        await fallback.events.agent_settled?.(event, context);
      },
    },
    async onStop() {
      fallback.dispose();
      transferVoiceTool?.dispose();
      voiceToolFacades?.dispose();
      const manualUi = lastUi;
      active = false;
      sessionGeneration += 1;
      reconcileVoiceTools('disabled');
      narrationToolRuntime = undefined;
      voiceToolCatalogSubscription?.();
      voiceToolCatalogSubscription = undefined;
      voiceToolSession?.setActive(false);
      voiceToolSession?.dispose();
      voiceToolSession = undefined;
      ownershipDispose?.();
      ownershipDispose = undefined;
      activeContext = undefined;
      const autoUi = lastAutoUi;
      lastUi = undefined;
      lastAutoUi = undefined;
      await autoController.shutdown(autoUi);
      await controller.shutdown(manualUi);
    },
  };
}
