import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  globalDoomConfigPath,
  mergeDoomConfigs,
  parseDoomConfig,
  repositoryDoomConfigPath,
  resolveVoiceConfig,
} from '@agimon-ai/doompi-config/config';
import { type DoomConfig, type IDoomConfigLoader, type ResolvedVoiceConfig } from '@agimon-ai/doompi-config/types';
import { DOOM_ASK_USER_BLOCKED_EVENT } from '@agimon-ai/doompi-extension-contracts/ask-user';
import type { LeaderBinding } from '@agimon-ai/doompi-extension-contracts/leader';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeOwnerHandle,
  type MinorModeState,
  registerMinorModeOwner,
  requireMinorModeCatalog,
} from '@agimon-ai/doompi-extension-contracts/mode';
import {
  DOOM_NARRATION_SERVICE,
  DOOM_VOICE_AUTO_MODE_ID,
  DOOM_VOICE_SOURCE,
  type DoomNarrationService,
  isNarrationRequest,
} from '@agimon-ai/doompi-extension-contracts/narration';
import {
  createDoomVoiceToolsService,
  DOOM_VOICE_TOOLS_SERVICE,
  VOICE_MODE_TOOL_NAMES,
  VOICE_NARRATE_TOOL_NAME,
  type VoiceToolSessionHandle,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AutonomousTurnNonceFactory } from '../../services/autonomousTurn.ts';
import {
  type IVoiceCommandCorrectionModelClient,
  type IVoiceCommandCorrector,
  type VoiceCommandCorrectionModelRequest,
  VoiceCommandCorrector,
} from '../../services/commandCorrection.ts';
import {
  type FallbackNarrationModelRequest,
  type IFallbackNarrationModelClient,
  type IVoiceNarrationCompactor,
  type IVoiceTurnFallbackNarrator,
  VoiceTurnFallbackNarrator,
} from '../../services/fallbackNarration.ts';
import type { NarrationPlaybackOutcome } from '../../services/narration.ts';
import {
  type IVoiceTranscriptAdmissionModelClient,
  type IVoiceTranscriptAdjudicator,
  type VoiceTranscriptAdmissionModelRequest,
  VoiceTranscriptAdjudicator,
} from '../../services/transcriptAdmission.ts';
import type { VoiceDeliveryIntent } from '../../services/voiceDelivery.ts';
import {
  type AutoCaptureActivationState,
  type AutoCaptureIndicatorState,
  type AutoCaptureUi,
  type IAudioAnalyzer,
  type IAudioRecorder,
  type IClock,
  type ITemporaryWorkspace,
  type ITranscriberRegistry,
  type IVoiceSessionController,
  type VoiceDependencies,
  type RecordingHandle,
  type SelectedTranscriber,
  type TimerHandle,
  type VoiceActivityUpdate,
  type VoiceState,
  type VoiceUi,
} from '../../types/index.ts';
import {
  ExecutableResolver,
  FfmpegAudioRecorder,
  FfmpegPcmAudioRecorder,
  MacOsSayPcmSynthesizer,
  MacOsSayTtsAdapter,
  NodeBinaryProcessSpawner,
  NodeProcessSpawner,
  PcmWavAnalyzer,
  SystemClock,
} from '../audio/infrastructure.ts';
import { ClientPcmAudioRecorder, ClientTtsAdapter, voiceMediaHostConnection } from '../audio/clientMedia.ts';
import { VoiceWorkerAutoCaptureController } from '../process/voiceWorkerAutoCaptureController.ts';
import {
  type VoiceWorkerSessionClientFactory,
  VoiceWorkerSessionController,
} from '../process/voiceWorkerSessionController.ts';
import {
  MlxWhisperAdapter,
  OpenAiWhisperAdapter,
  TranscriberRegistry,
  WhisperCppAdapter,
} from '../transcription/whisper.ts';
import { createMinorModeVoiceTool, createVoiceMinorModeCatalog } from './minorModeCatalog.ts';
import { isNarrationRuntimeActive, type NarrationToolRuntime, registerNarrationTool } from './narrationTool.ts';
import { collectVoiceCommandContext } from './voiceCommandContext.ts';
import { registerVoiceToolFacades } from './voiceTools.ts';
import { createTransferVoiceToolLifecycle } from './transferVoiceTool.ts';
import {
  registerSessionVoiceOwnership,
  SessionVoiceOwnershipBridge,
  sessionVoiceOwnership,
  type VoiceOwnershipSessionHost,
  voiceOwnershipLabel,
} from '../../services/sessionVoiceOwnership.ts';
import { VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS } from '../../types/voiceOwnership.ts';

export {
  MlxWhisperAdapter,
  OpenAiWhisperAdapter,
  TranscriberRegistry,
  WhisperCppAdapter,
} from '../transcription/whisper.ts';

interface VoiceSessionContextLike {
  sessionManager?: { getSessionId(): string };
}

const VOICE_SOURCE = DOOM_VOICE_SOURCE;
const COMMAND_NAME = 'voice';
const AUTO_COMMAND_NAME = DOOM_VOICE_AUTO_MODE_ID;
const STATUS_KEY = 'doom-voice';
const MAX_RECORDING_MS = 300_000;
const ACTIVITY_INTERVAL_MS = 120;
const LEADER_GROUP_ORDER = 67;
const AUTO_LEADER_DETAIL = 'autonomous capture with agent narration';
const AUTO_MODE_LABEL = 'Voice';
const AUTO_MODE_COLOR = 'accent' as const;

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
export function canRunVoice(context: { hasUI?: boolean } | undefined): boolean {
  return context?.hasUI === true;
}

/** Manual capture needs the same browser media ownership as autonomous capture. */
export function voiceOwnershipState(
  manualState: VoiceState,
  autonomousState: AutoCaptureActivationState,
): AutoCaptureActivationState {
  return manualState === 'idle' ? autonomousState : 'active';
}

export function voiceModeState(state: AutoCaptureActivationState, canRun = false): MinorModeState {
  const active = state !== 'disabled';
  const transitioning = state === 'starting' || state === 'draining' || state === 'shuttingDown';
  return {
    activation:
      state === 'starting'
        ? 'activating'
        : state === 'draining' || state === 'shuttingDown'
          ? 'deactivating'
          : active
            ? 'active'
            : 'inactive',
    condition: transitioning ? 'queued' : 'ready',
    ...(active ? { detail: state, color: AUTO_MODE_COLOR } : {}),
    actions: !canRun
      ? [
          {
            id: 'activate',
            enabled: false,
            disabledReason: 'Autonomous voice needs a session that can show its indicator.',
          },
          {
            id: 'manual',
            enabled: false,
            disabledReason: 'Manual voice needs a session that can show its indicator.',
          },
          {
            id: 'deactivate',
            enabled: false,
            disabledReason: 'Autonomous voice needs a session that can show its indicator.',
          },
        ]
      : transitioning
        ? [
            { id: 'activate', enabled: false, disabledReason: 'Autonomous voice is transitioning.' },
            { id: 'manual', enabled: false, disabledReason: 'Autonomous voice is transitioning.' },
            { id: 'deactivate', enabled: false, disabledReason: 'Autonomous voice is transitioning.' },
          ]
        : [
            ...(active
              ? [{ id: 'activate', enabled: false, disabledReason: 'Autonomous voice is already enabled.' } as const]
              : [{ id: 'activate', enabled: true } as const]),
            ...(active
              ? [
                  {
                    id: 'manual',
                    enabled: false,
                    disabledReason: 'Disable autonomous voice before using manual voice.',
                  } as const,
                ]
              : [{ id: 'manual', enabled: true } as const]),
            ...(active
              ? [{ id: 'deactivate', enabled: true } as const]
              : [{ id: 'deactivate', enabled: false, disabledReason: 'Autonomous voice is disabled.' } as const]),
          ],
  };
}

const RECORDING_FRAMES = ['·', '•', '●', '•'] as const;
const TRANSCRIBING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const INFO_NOTIFICATION = 'info';
const ERROR_NOTIFICATION = 'error';
const RECORDING_REQUESTED_EVENT = 'doom_voice.recording_requested';
const RECORDING_STARTED_EVENT = 'doom_voice.recording_started';
const RECORDING_FAILED_EVENT = 'doom_voice.recording_failed';
const RECORDING_FINISHED_EVENT = 'doom_voice.recording_finished';
const TRANSCRIPTION_STARTED_EVENT = 'doom_voice.transcription_started';
const TRANSCRIPTION_FINISHED_EVENT = 'doom_voice.transcription_finished';
const TRANSCRIPTION_FAILED_EVENT = 'doom_voice.transcription_failed';
const IDLE_STATE = 'idle' as const;
const RECORDING_STATE = 'recording' as const;
const TRANSCRIBING_STATE = 'transcribing' as const;

export interface VoiceFooterContributionValue {
  fullText: string;
  compactText: string;
  fullSegments: Array<{ text: string; color: 'warning' | 'accent' }>;
  compactSegments: Array<{ text: string; color: 'warning' | 'accent' }>;
}

/** The leader half of the same indirection the footer uses across the adapter split. */
export interface VoiceLeaderContributionHandle {
  update(bindings: readonly LeaderBinding[]): void;
}

export interface VoiceFooterContributionHandle {
  update(value: VoiceFooterContributionValue | undefined): void;
  dispose(): void;
}

const VOICE_GROUP_SEGMENT = {
  key: 'v',
  label: 'voice',
  detail: 'dictation and narration',
  order: LEADER_GROUP_ORDER,
} as const;

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

export interface VoiceActivityPresentation {
  statusText: string;
  footer: VoiceFooterContributionValue;
}

export interface AutoCaptureActivityPresentation {
  statusText: string;
  footer: VoiceFooterContributionValue;
}

export function formatVoiceActivity(update: VoiceActivityUpdate): VoiceActivityPresentation {
  const frames = update.state === RECORDING_STATE ? RECORDING_FRAMES : TRANSCRIBING_FRAMES;
  const frameIndex = Math.max(0, Math.floor(update.frameIndex)) % frames.length;
  const frame = frames[frameIndex]!;
  const color = update.state === RECORDING_STATE ? ('warning' as const) : ('accent' as const);
  const elapsed = Math.max(0, Math.floor(update.elapsedSeconds ?? 0));
  const statusText =
    update.state === RECORDING_STATE
      ? `${frame} voice: recording ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
      : `${frame} voice: transcribing`;
  return {
    statusText,
    footer: {
      fullText: frame,
      compactText: frame,
      fullSegments: [{ text: frame, color }],
      compactSegments: [{ text: frame, color }],
    },
  };
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

export function formatAutoCaptureActivity(state: AutoCaptureIndicatorState): AutoCaptureActivityPresentation {
  const presentation =
    state === 'listening'
      ? { frame: 'A', statusText: 'voice auto: listening', color: 'accent' as const }
      : state === 'speech'
        ? { frame: '!', statusText: 'voice auto: hearing speech', color: 'warning' as const }
        : state === 'processing'
          ? { frame: '…', statusText: 'voice auto: processing while listening', color: 'accent' as const }
          : state === 'narrating'
            ? { frame: 'A', statusText: 'voice auto: narrating and listening', color: 'accent' as const }
            : state === 'confirming'
              ? { frame: '?', statusText: 'voice auto: confirmation needed', color: 'warning' as const }
              : state === 'waiting'
                ? { frame: '…', statusText: 'voice auto: waiting for keyboard input', color: 'warning' as const }
                : { frame: 'A', statusText: 'voice auto: draining', color: 'warning' as const };
  return {
    statusText: presentation.statusText,
    footer: {
      fullText: presentation.frame,
      compactText: presentation.frame,
      fullSegments: [{ text: presentation.frame, color: presentation.color }],
      compactSegments: [{ text: presentation.frame, color: presentation.color }],
    },
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

export function createVoiceNarrationService(
  controller: Pick<VoiceWorkerAutoCaptureController, 'narrateExternal'>,
): DoomNarrationService {
  const service: DoomNarrationService = {
    generation: `${VOICE_SOURCE}:narration:${crypto.randomUUID()}`,
    async request(request) {
      if (!isNarrationRequest(request)) throw new Error('Invalid narration request.');
      await controller.narrateExternal(request.text);
    },
  };
  return Object.freeze(service);
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

export function registerVoiceTurnFallback(pi: Pick<ExtensionAPI, 'on'>, runtime: VoiceTurnFallbackRuntime): () => void {
  let turn: VoiceTurnFallbackState | undefined;
  let active = true;
  pi.on('before_agent_start', (_event, context) => {
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
  });
  pi.on('tool_execution_start', (event, context) => {
    if (!active) return;
    if (event.toolName === VOICE_NARRATE_TOOL_NAME && turn && sameFallbackTurn(turn, context)) {
      turn.narrateAttempted = true;
    }
  });
  pi.on('turn_end', (event, context) => {
    if (!active || !turn || !sameFallbackTurn(turn, context)) return;
    const finalResponse = extractTerminalAssistantText(event.message);
    if (finalResponse) turn.finalResponse = finalResponse;
  });
  pi.on('agent_settled', async (_event, context) => {
    if (!active) return;
    const settled = turn;
    turn = undefined;
    if (!settled || settled.narrateAttempted || !settled.finalResponse || !sameFallbackTurn(settled, context)) return;
    if (runtime.activeGeneration(context) !== settled.activationId) return;
    await runtime.narrate(settled.finalResponse, context.signal);
  });
  return () => {
    active = false;
    turn = undefined;
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

export class VoiceSessionController implements IVoiceSessionController {
  private currentState: VoiceState = IDLE_STATE;
  private recording?: RecordingHandle;
  private workspace?: string;
  private config?: ResolvedVoiceConfig;
  private selected?: SelectedTranscriber;
  private startedAt = 0;
  private activityFrame = 0;
  private activityTimer?: TimerHandle;
  private limitTimer?: TimerHandle;
  private readonly telemetry = createDoomTelemetry({
    serviceName: STATUS_KEY,
    packageName: VOICE_SOURCE,
    env: process.env,
    enableLogs: true,
    enableTraces: true,
  });
  constructor(
    private readonly configs: IDoomConfigLoader,
    private readonly clock: IClock,
    private readonly workspaces: ITemporaryWorkspace,
    private readonly recorder: IAudioRecorder,
    private readonly analyzer: IAudioAnalyzer,
    private readonly registry: ITranscriberRegistry,
  ) {}
  get state(): VoiceState {
    return this.currentState;
  }
  async toggle(ui: VoiceUi): Promise<void> {
    if (this.currentState === TRANSCRIBING_STATE) {
      ui.notify('Voice transcription is already running', INFO_NOTIFICATION);
      return;
    }
    if (this.currentState === RECORDING_STATE) {
      await this.stopAndTranscribe(ui);
      return;
    }
    await this.startRecording(ui);
  }
  private async startRecording(ui: VoiceUi): Promise<void> {
    try {
      const projectRoot = process.env.PI_PROJECT_ROOT ?? process.cwd();
      const loaded = this.configs.load(projectRoot).voice;
      if (!loaded) throw new Error('Voice is not configured in the Pi agent configuration.');
      const config = resolveVoiceConfig(loaded);
      this.recorder.preflight(config);
      const selected = this.registry.select(config);
      void this.telemetry.recordEvent(RECORDING_REQUESTED_EVENT, {
        engine: selected.adapter.engine,
        mode: config.language,
      });
      const workspace = this.workspaces.create();
      this.recording = this.recorder.start(config, workspace);
      this.workspace = workspace;
      this.config = config;
      this.selected = selected;
      this.currentState = RECORDING_STATE;
      this.startedAt = this.clock.now();
      this.startActivity(ui);
      this.limitTimer = this.clock.setTimeout(() => {
        void this.stopAndTranscribe(ui);
      }, MAX_RECORDING_MS);
      void this.telemetry.recordEvent(RECORDING_STARTED_EVENT, {
        engine: selected.adapter.engine,
        outcome: 'started',
      });
    } catch (error) {
      await this.telemetry.recordError(RECORDING_FAILED_EVENT, error, { outcome: 'failed' });
      this.reset(ui);
      ui.notify(error instanceof Error ? error.message : String(error), ERROR_NOTIFICATION);
    }
  }
  private startActivity(ui: VoiceUi): void {
    this.activityFrame = 0;
    this.publishActivity(ui);
    this.activityTimer = this.clock.setInterval(() => {
      this.activityFrame += 1;
      this.publishActivity(ui);
    }, ACTIVITY_INTERVAL_MS);
  }
  private publishActivity(ui: VoiceUi): void {
    if (this.currentState === IDLE_STATE) return;
    const update: VoiceActivityUpdate = {
      state: this.currentState,
      frameIndex: this.activityFrame,
      ...(this.currentState === RECORDING_STATE
        ? { elapsedSeconds: Math.max(0, Math.floor((this.clock.now() - this.startedAt) / 1_000)) }
        : {}),
    };
    ui.setIndicator(update);
    ui.setStatus(STATUS_KEY, formatVoiceActivity(update).statusText);
  }
  private async stopAndTranscribe(ui: VoiceUi): Promise<void> {
    const recording = this.recording;
    const workspace = this.workspace;
    const config = this.config;
    const selected = this.selected;
    if (!recording || !workspace || !config || !selected || this.currentState !== RECORDING_STATE) return;
    this.clearTimers();
    const recordingStartedAt = this.startedAt;
    this.currentState = TRANSCRIBING_STATE;
    this.startActivity(ui);
    void this.telemetry.recordEvent(TRANSCRIPTION_STARTED_EVENT, {
      engine: selected.adapter.engine,
      duration_ms: Math.max(0, this.clock.now() - recordingStartedAt),
    });
    try {
      await recording.stop();
      const recordingDurationMs = Math.max(0, this.clock.now() - recordingStartedAt);
      if (this.analyzer.analyze(recording.filePath).silent) {
        await this.telemetry.recordEvent(TRANSCRIPTION_FINISHED_EVENT, {
          engine: selected.adapter.engine,
          duration_ms: recordingDurationMs,
          silence: true,
          outcome: 'empty',
        });
        ui.notify('No speech detected', INFO_NOTIFICATION);
        return;
      }
      const transcription = await selected.adapter.transcribe({
        audioPath: recording.filePath,
        workspace,
        config: selected.config,
        language: config.language,
      });
      const transcript = (typeof transcription === 'string' ? transcription : transcription.transcript).trim();
      if (!transcript) {
        await this.telemetry.recordEvent(TRANSCRIPTION_FINISHED_EVENT, {
          engine: selected.adapter.engine,
          duration_ms: recordingDurationMs,
          empty: true,
          outcome: 'empty',
        });
        ui.notify('Voice transcription was empty', INFO_NOTIFICATION);
        return;
      }
      const draft = ui.getEditorText();
      ui.setEditorText(`${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}${transcript}`);
      await this.telemetry.recordEvent(TRANSCRIPTION_FINISHED_EVENT, {
        engine: selected.adapter.engine,
        duration_ms: recordingDurationMs,
        empty: false,
        outcome: 'completed',
      });
    } catch (error) {
      await this.telemetry.recordError(TRANSCRIPTION_FAILED_EVENT, error, {
        engine: selected.adapter.engine,
        duration_ms: Math.max(0, this.clock.now() - recordingStartedAt),
      });
      ui.notify(error instanceof Error ? error.message : String(error), ERROR_NOTIFICATION);
    } finally {
      this.reset(ui);
    }
  }
  async shutdown(ui?: VoiceUi): Promise<void> {
    this.clearTimers();
    if (this.recording && this.currentState === RECORDING_STATE) {
      await this.recording.abort();
      void this.telemetry.recordEvent(RECORDING_FINISHED_EVENT, { outcome: 'aborted' });
    }
    this.reset(ui);
    void this.telemetry.shutdown();
  }
  private clearTimers(): void {
    if (this.activityTimer) this.clock.clear(this.activityTimer);
    if (this.limitTimer) this.clock.clear(this.limitTimer);
    this.activityTimer = undefined;
    this.limitTimer = undefined;
  }
  private reset(ui?: VoiceUi): void {
    this.clearTimers();
    if (this.workspace) this.workspaces.remove(this.workspace);
    this.recording = undefined;
    this.workspace = undefined;
    this.config = undefined;
    this.selected = undefined;
    this.currentState = IDLE_STATE;
    this.activityFrame = 0;
    ui?.setIndicator(undefined);
    ui?.setStatus(STATUS_KEY, undefined);
  }
}

function readVoiceConfig(filePath: string): DoomConfig {
  if (!fs.existsSync(filePath)) return { projectTrust: 'ask' };
  return parseDoomConfig(fs.readFileSync(filePath, 'utf8'), filePath);
}

function voiceAgentConfigPath(homeDirectory: string): string {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(homeDirectory, '.pi', 'agent');
  return path.join(agentDirectory, 'doom-voice', 'config.yaml');
}

/**
 * Shared Doom config owns `voice:`; the package-scoped file is the fallback for
 * standalone installs that have no Doom config.
 */
function readGlobalVoiceConfig(homeDirectory: string): DoomConfig {
  const doomConfig = readVoiceConfig(globalDoomConfigPath(homeDirectory));
  if (doomConfig.voice) return doomConfig;
  const packageConfig = readVoiceConfig(voiceAgentConfigPath(homeDirectory));
  return packageConfig.voice ? mergeDoomConfigs(doomConfig, packageConfig) : doomConfig;
}

export class PiVoiceConfigService implements IDoomConfigLoader {
  load(repoRoot: string, homeDirectory = os.homedir()): DoomConfig {
    const globalConfig = readGlobalVoiceConfig(homeDirectory);
    const trusted = process.env.PI_PROJECT_TRUST === 'trusted';
    if (!trusted) return globalConfig;

    const projectPath = repositoryDoomConfigPath(repoRoot);
    const projectConfig = readVoiceConfig(projectPath);
    if (projectConfig.projectTrust === 'never') return globalConfig;
    return mergeDoomConfigs(globalConfig, projectConfig);
  }
}

/**
 * Compose the voice runtime.
 *
 * Construction order is the dependency order, so the graph reads top to bottom
 * and a cycle is a compile error rather than a resolution failure at runtime.
 */
export function createVoiceContainer(overrides: Partial<VoiceDependencies> = {}): VoiceDependencies {
  const clock = overrides.clock ?? new SystemClock();
  const executables = overrides.executables ?? new ExecutableResolver();
  const spawner = overrides.spawner ?? new NodeProcessSpawner();
  const binarySpawner = overrides.binarySpawner ?? new NodeBinaryProcessSpawner();
  const clientMedia = voiceMediaHostConnection();

  const configs = overrides.configs ?? new PiVoiceConfigService();
  const whisperCpp = overrides.whisperCpp ?? new WhisperCppAdapter(executables, spawner);
  const openAiWhisper = overrides.openAiWhisper ?? new OpenAiWhisperAdapter(executables, spawner);
  const mlxWhisper = overrides.mlxWhisper ?? new MlxWhisperAdapter(executables, spawner);
  const registry = overrides.registry ?? new TranscriberRegistry(whisperCpp, openAiWhisper, mlxWhisper);

  return {
    clock,
    executables,
    spawner,
    binarySpawner,
    configs,
    recorder: overrides.recorder ?? new FfmpegAudioRecorder(executables, spawner, clock),
    pcmRecorder:
      overrides.pcmRecorder ??
      (clientMedia
        ? new ClientPcmAudioRecorder(clientMedia)
        : new FfmpegPcmAudioRecorder(executables, binarySpawner, clock)),
    tts:
      overrides.tts ??
      (clientMedia
        ? new ClientTtsAdapter(clientMedia, clock, new MacOsSayPcmSynthesizer(executables, binarySpawner))
        : new MacOsSayTtsAdapter(executables, binarySpawner, clock)),
    analyzer: overrides.analyzer ?? new PcmWavAnalyzer(),
    whisperCpp,
    openAiWhisper,
    mlxWhisper,
    registry,
    sessionController: overrides.sessionController ?? new VoiceWorkerSessionController(configs, clock),
  };
}

export function reconcileVoiceModeTools(pi: ExtensionAPI, enabled: boolean): void {
  const activeTools = pi.getActiveTools();
  const voiceToolNames = new Set<string>(VOICE_MODE_TOOL_NAMES);
  const registeredNames = new Set(pi.getAllTools().map((tool) => tool.name));
  const nextTools = activeTools.filter((name) => !voiceToolNames.has(name));
  if (enabled && VOICE_MODE_TOOL_NAMES.every((name) => registeredNames.has(name))) {
    nextTools.push(...VOICE_MODE_TOOL_NAMES);
  }
  if (nextTools.length !== activeTools.length || nextTools.some((name, index) => name !== activeTools[index])) {
    pi.setActiveTools(nextTools);
  }
}

export interface VoiceExtensionOptions {
  footer?: VoiceFooterContributionHandle;
  leader?: VoiceLeaderContributionHandle;
  container?: VoiceDependencies;
  ownershipHost?: VoiceOwnershipSessionHost;
  autoClientFactory?: VoiceWorkerSessionClientFactory;
  identityNonceFactory?: AutonomousTurnNonceFactory;
  waitUntilConfigured?: (context: ExtensionContext, signal?: AbortSignal) => Promise<void>;
}

export function installVoiceRuntime(cordis: Context, pi: ExtensionAPI, options: VoiceExtensionOptions = {}): void {
  cordis.effect(function* () {
    const container = options.container ?? createVoiceContainer();
    const ownershipHost = options.ownershipHost;
    const controller = container.sessionController;
    const configs = container.configs;
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
    cordis.provide(DOOM_VOICE_TOOLS_SERVICE, voiceTools);
    yield () => voiceTools.dispose();
    let voiceToolSession: VoiceToolSessionHandle<ExtensionContext> | undefined;
    // Contributors register through cordis injection, so they all land after the façade
    // is registered. Without this the description would be built once, from an empty
    // catalog, and never name a capability.
    let voiceToolCatalogSubscription: (() => void) | undefined;
    let narrationToolRuntime: NarrationToolRuntime | undefined;
    let active = true;
    let sessionGeneration = 0;
    yield async () => controller.shutdown(lastUi);
    yield () => {
      active = false;
      sessionGeneration += 1;
      activeContext = undefined;
      narrationToolRuntime = undefined;
    };

    const transferVoiceTool = typeof pi.registerTool === 'function' ? createTransferVoiceToolLifecycle(pi) : undefined;
    if (transferVoiceTool) yield () => transferVoiceTool.dispose();

    const voiceToolFacades =
      typeof pi.registerTool === 'function'
        ? registerVoiceToolFacades(pi, () => voiceToolSession, options.waitUntilConfigured)
        : undefined;
    if (voiceToolFacades) yield () => voiceToolFacades.dispose();

    const modeCatalog = createVoiceMinorModeCatalog(cordis);
    yield () => modeCatalog.dispose();

    const modeToolContribution = voiceTools.register(createMinorModeVoiceTool(modeCatalog));
    yield () => modeToolContribution.dispose();
    let mode: Pick<MinorModeOwnerHandle, 'publish' | 'dispose'> | undefined;
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
      reconcileVoiceModeTools(pi, enabled);
      voiceToolFacades?.refresh();
    };
    const autoController = new VoiceWorkerAutoCaptureController({
      loadConfig: () => {
        const root = process.env.PI_PROJECT_ROOT ?? process.cwd();
        const loaded = configs.load(root).voice;
        if (!loaded) throw new Error('Voice is not configured in the Pi agent configuration.');
        return resolveVoiceConfig(loaded);
      },
      resolveCommandCorrector: async (reference) => {
        if (!activeContext) throw new Error('No autonomous voice session is active');
        return resolveVoiceCommandCorrector(reference, activeContext);
      },
      resolveTranscriptAdjudicator: async (reference) => {
        if (!activeContext) throw new Error('No autonomous voice session is active');
        return resolveVoiceTranscriptAdjudicator(reference, activeContext, container.clock);
      },
      resolveFallbackNarrator: async (reference) => {
        if (!activeContext) throw new Error('No autonomous voice session is active');
        return resolveVoiceFallbackNarrator(reference, activeContext);
      },
      tts: container.tts,
      clock: container.clock,
      deliver: (text, intent) => {
        if (!activeContext) throw new Error('No autonomous voice session is active');
        deliverAutoCaptureInput(pi, activeContext, text, intent);
      },
      manualState: () => controller.state,
      commandContext: () =>
        activeContext
          ? collectVoiceCommandContext(activeContext.sessionManager.getBranch(), modeCatalog.records())
          : undefined,
      onActivationStateChange: (state) => {
        if (!active) return;
        reconcileVoiceTools(state);
        mode?.publish(voiceModeState(state, canRunVoice(activeContext)));
        // Republished here rather than only at registration: the `e` row is the
        // one entry whose label depends on the controller, and the panel is read
        // between activations, not just at session start.
        leader.update(voiceLeaderBindings(state !== 'disabled'));
      },
      ...(options.autoClientFactory ? { clientFactory: options.autoClientFactory } : {}),
      ...(options.identityNonceFactory ? { identityNonceFactory: options.identityNonceFactory } : {}),
    });
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
      mode?.publish(voiceModeState('starting', canRunVoice(context)));
      try {
        await bridge.synchronize();
      } catch (error) {
        sessionVoiceOwnership.clearActivationRequest(request.requestId);
        ui.setIndicator(undefined);
        ui.setStatus(undefined);
        mode?.publish(voiceModeState('disabled', canRunVoice(context)));
        throw error;
      }
      container.clock.setTimeout(() => {
        if (sessionVoiceOwnership.snapshot().activation?.requestId !== request.requestId) return;
        sessionVoiceOwnership.clearActivationRequest(request.requestId);
        ui.setIndicator(undefined);
        ui.setStatus(undefined);
        mode?.publish(voiceModeState('disabled', canRunVoice(context)));
        ui.notify('Autonomous voice activation timed out while waiting for session ownership.', 'error');
      }, VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS);
    };

    cordis.provide(DOOM_NARRATION_SERVICE, createVoiceNarrationService(autoController));
    if (typeof pi.registerTool === 'function') {
      registerNarrationTool(pi, () => narrationToolRuntime, options.waitUntilConfigured);
    }
    cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
      const owner = registerMinorModeOwner<ExtensionContext>(requireMinorModeCatalog(modeContext), {
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
        initialState: voiceModeState('disabled'),
        async handleAction(actionId, _argumentsValue, execution) {
          if (!active) throw new Error('Voice runtime is disposed.');
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
      });
      mode = owner;
      return () => {
        owner.dispose();
        if (mode === owner) mode = undefined;
      };
    });

    pi.registerCommand(COMMAND_NAME, {
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
    });
    pi.registerCommand(AUTO_COMMAND_NAME, {
      description: 'Toggle autonomous voice capture, or mute and unmute its microphone',
      handler: async (args, ctx) => {
        if (!active || !ctx.hasUI) return;
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
        if (microphoneAction) {
          lastAutoUi.notify('Usage: /voice-auto [mute|unmute]', INFO_NOTIFICATION);
          return;
        }
        if (autoController.state === 'disabled') await requestAutonomousActivation(lastAutoUi, ctx);
        else await autoController.deactivate(lastAutoUi);
      },
    });
    let ownershipDispose: (() => void) | undefined;
    let ownershipBridge: SessionVoiceOwnershipBridge | undefined;
    yield () => {
      ownershipBridge?.stop();
      ownershipDispose?.();
    };
    pi.on('session_start', async (event, ctx) => {
      if (!active) return;
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
      mode?.publish(voiceModeState('disabled', canRunVoice(ctx)));
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
              mode?.publish(voiceModeState('disabled', canRunVoice(activeContext)));
            }
          },
        },
      });
      lastUi = createVoiceUi(ctx, footer);
      lastAutoUi = createAutoCaptureUi(ctx, footer);
      lastUi.setIndicator(undefined);
      lastUi.setStatus(STATUS_KEY, undefined);
      if (ownershipHost !== undefined) {
        ownershipBridge = new SessionVoiceOwnershipBridge(sessionVoiceOwnership, ownershipHost, container.clock);
        ownershipBridge.start();
      }
      if (reloadHandoff && lastAutoUi) {
        if (ownershipHost === undefined) await autoController.activate(lastAutoUi);
        else await requestAutonomousActivation(lastAutoUi, ctx);
      }
    });
    pi.on('before_agent_start', (_event, ctx) => {
      if (!active) return;
      activeContext = ctx;
      const sessionId = (ctx as unknown as VoiceSessionContextLike).sessionManager?.getSessionId();
      narrationToolRuntime =
        voiceToolSession && sessionId === voiceToolSession.sessionId
          ? { context: ctx, session: voiceToolSession, controller: autoController }
          : undefined;
      reconcileVoiceTools(autoController.state);
    });
    const disposeVoiceTurnFallback = registerVoiceTurnFallback(pi, {
      activeGeneration: (context) =>
        active && isNarrationRuntimeActive(narrationToolRuntime, context) ? autoController.activationId : undefined,
      narrate: (finalResponse, signal) => autoController.narrateFallback(finalResponse, signal),
    });
    yield disposeVoiceTurnFallback;
    const disposeAutoCaptureEvents = registerAutoCaptureCordisEventHandlers(cordis, autoController);
    yield disposeAutoCaptureEvents;
    yield async () => {
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
    };
  }, `${VOICE_SOURCE}/runtime`);
}
