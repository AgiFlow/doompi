import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { loadDoomConfig, resolveVoiceConfig } from '@agimon-ai/doompi-config';
import type { DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import type { DoomApiContext, DoomPeerAgentRegistry } from '@agimon-ai/doompi-core/packageApi';
import {
  defineServerMethod,
  readPackageResource,
  type DoomServerSessionPlugin,
} from '@agimon-ai/doompi-core/serverFacet';
import {
  DOOM_VOICE_AUTO_MODE_ID,
  DOOM_VOICE_TOOLS_SERVICE,
  VOICE_TOOL_ERROR_CODE,
  type VoiceToolErrorCode,
} from '@agimon-ai/doompi-core/voiceTools';
import {
  VoiceToolDescribeInputSchema,
  VoiceToolUseInputSchema,
  type VoiceToolDescribeInput,
  type VoiceToolUseInput,
} from '@agimon-ai/doompi-core/voiceTools';
import { defineMinorMode, serverMinorModes, type MinorModeOwner } from '@agimon-ai/doompi-minor-mode';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';
import { Check } from 'typebox/value';

import { VOICE_API_BASE_PATH } from '../../constants/voice';
import { voiceControlMethod } from '../../schemas/voiceControl';
import { ClientTtsAdapter } from '../../services/clientMedia';
import { VoiceCommandCorrector } from '../../services/commandCorrection';
import { VoiceTurnFallbackNarrator } from '../../services/fallbackNarration';
import {
  ExecutableResolver,
  MacOsSayPcmSynthesizer,
  NodeBinaryProcessSpawner,
  SystemClock,
} from '../../services/infrastructure';
import { SessionVoiceOwnership, SessionVoiceOwnershipBridge } from '../../services/sessionVoiceOwnership';
import { VoiceTranscriptAdjudicator } from '../../services/transcriptAdmission';
import { voiceReadiness } from '../../services/voiceReadiness';
import { createDoomVoiceToolsService } from '../../services/voiceTools';
import { VoiceWorkerAutoCaptureController } from '../../services/voiceWorkerAutoCaptureController';
import { VoiceWorkerClient } from '../../services/voiceWorkerClient';
import { VoiceWorkerSessionController } from '../../services/voiceWorkerSessionController';
import type { AutoCaptureUi, VoiceUi } from '../../types';
import type { VoiceMediaBroker } from '../clientMediaApi';
import type { GlobalLiveControl, GlobalLiveStatus } from '../globalLiveCompanion/type';
import { LiveAgentSession } from '../liveAgentSession';
import { LiveVoiceController } from '../liveVoiceController';
import { VoiceModeController } from '../voiceModeController';
import { registerVoicePeerAgent } from '../voicePeerRelay';

const SOURCE = '@agimon-ai/doompi-voice';
const when = {
  state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID },
  attribution: { kind: 'minor' as const, mode: DOOM_VOICE_AUTO_MODE_ID },
};

/** Native session operations. Configuration and browser media are supplied by the server mount. */
export function createVoiceServer(
  host: DoomHeadlessHostService,
  broker?: VoiceMediaBroker,
  homeDirectory?: string,
  hubToken?: string,
  peerAgents?: DoomPeerAgentRegistry,
  requestApi?: DoomApiContext['requestApi'],
): DoomServerSessionPlugin {
  const execution = host.context;
  if (!broker || !homeDirectory) throw new Error('Voice requires the session media broker and configured server home.');
  const clock = new SystemClock();
  const ownership = new SessionVoiceOwnership();
  const load = () => loadDoomConfig(execution.repoRoot, homeDirectory);
  const config = () => {
    const voice = load().voice;
    if (!voice) throw new Error('Configure Voice in settings before starting capture.');
    return resolveVoiceConfig(voice);
  };
  const spoolDirectory = join(homeDirectory, '.pi', '.doom', 'voice', 'spool', execution.sessionId);
  const clientFactory = (options: ConstructorParameters<typeof VoiceWorkerClient>[0]) =>
    new VoiceWorkerClient({ ...options, clientMedia: broker.media, environment: { ...execution.environment } });
  const notify: VoiceUi['notify'] = (body, level = 'info') => {
    void execution.client.notify({ body, level });
  };
  const manual = new VoiceWorkerSessionController({ load }, clock, clientFactory, {
    loadConfig: config,
    spoolDirectory,
    environment: { ...execution.environment },
  });
  const manualUi: VoiceUi = {
    notify,
    setStatus: (_key, value) => execution.client.setStatus('doom-voice', value),
    setIndicator: () => undefined,
    appendText: (text) => {
      host.assertActive();
      if (!execution.client.appendComposerText) throw new Error('The client cannot append dictation to its composer.');
      execution.client.appendComposerText(text);
    },
  };
  const autoUi: AutoCaptureUi = {
    notify,
    setStatus: (value) => execution.client.setStatus('doom-voice', value),
    setIndicator: () => undefined,
  };
  const modelClient = (reference: string) => {
    if (!execution.textCompletion?.available(reference)) throw new Error(`Voice model is not configured: ${reference}`);
    return {
      complete: (request: Parameters<NonNullable<typeof execution.textCompletion>['complete']>[1]) => {
        host.assertActive();
        return execution.textCompletion!.complete(reference, request);
      },
    };
  };
  let closed = false;
  let owner: MinorModeOwner | undefined;
  let toolRegistrations: Array<{ dispose(): void }> = [];
  let registeredTools: 'none' | 'session' | 'global' = 'none';
  let registeredCatalogRevision: string | undefined;
  const activationWaiters = new Set<() => void>();
  const changed = () => {
    for (const wake of activationWaiters) wake();
    owner?.publish();
    const selectedGlobal = !closed && liveAgent.selectedRoute !== undefined;
    if (!closed && mode.state === 'disabled') {
      const selected = host.context.selection.state?.['minor-mode']?.includes(DOOM_VOICE_AUTO_MODE_ID) ?? false;
      if (selected !== selectedGlobal)
        void select(selectedGlobal).catch((error: unknown) => notify(String(error), 'error'));
    }
    const catalog = selectedGlobal ? liveAgent.selectedCatalog : undefined;
    const next: typeof registeredTools = closed
      ? 'none'
      : mode.state === 'active'
        ? 'session'
        : catalog?.targets.length && liveAgent.nativeTransferAllowed
          ? 'global'
          : 'none';
    if (next === registeredTools && (next !== 'global' || registeredCatalogRevision === catalog?.revision)) return;
    for (const registration of toolRegistrations) registration.dispose();
    const transferTool = exposedTools.find((tool) => tool.name === 'transfer_voice');
    if (next === 'global' && !transferTool) throw new Error('Global Voice transfer tool is unavailable.');
    toolRegistrations =
      next === 'session'
        ? exposedTools.map((tool) => host.registerTool(tool))
        : next === 'global'
          ? [host.registerTool(transferTool!)]
          : [];
    registeredTools = next;
    registeredCatalogRevision = next === 'global' ? catalog?.revision : undefined;
  };
  const deliver = async (text: string, queued = false): Promise<void> => {
    host.assertActive();
    if (!execution.session.admitPrompt) throw new Error('The session cannot admit voice prompts.');
    const activity = await execution.session.activity();
    await execution.session.admitPrompt(text, queued || !activity.isIdle ? 'followUp' : 'prompt');
  };
  const liveAgent = new LiveAgentSession(
    execution.sessionId,
    hubToken,
    (text) => deliver(text),
    async () => {
      try {
        if (!closed && mode.state === 'disabled') {
          const selected = liveAgent.selectedRoute !== undefined;
          const current = host.context.selection.state?.['minor-mode']?.includes(DOOM_VOICE_AUTO_MODE_ID) ?? false;
          if (selected !== current) await select(selected);
        }
      } finally {
        changed();
      }
    },
  );
  const legacy = new VoiceWorkerAutoCaptureController({
    loadConfig: config,
    spoolDirectory,
    clock,
    clientFactory,
    resolveCommandCorrector: async (reference) => new VoiceCommandCorrector(modelClient(reference)),
    resolveTranscriptAdjudicator: async (reference) => new VoiceTranscriptAdjudicator(modelClient(reference), clock),
    resolveFallbackNarrator: async (reference) => new VoiceTurnFallbackNarrator(modelClient(reference)),
    tts: new ClientTtsAdapter(
      broker.media,
      clock,
      new MacOsSayPcmSynthesizer(new ExecutableResolver(), new NodeBinaryProcessSpawner()),
    ),
    deliver: (text, intent) => deliver(text, intent === 'queuedFollowUp'),
    manualState: () => manual.state,
    onActivationStateChange: changed,
    telemetrySink: createDoomTelemetry({
      serviceName: 'doom-voice-autonomous',
      packageName: SOURCE,
      env: { ...execution.environment },
      enableLogs: true,
      enableTraces: true,
    }),
  });
  interface NativeVoiceRun {
    runId: string;
    turnId?: string;
    generation: number;
    narrationAttempted: boolean;
    narrationCompleted: boolean;
    finalText?: string;
  }
  const nativeRuns = new Map<string, NativeVoiceRun>();
  const narrationDrains = new Set<Promise<void>>();
  const narrationToolRuns = new Map<string, string>();
  let voiceGeneration = 0;
  const hasSourceWork = () => nativeRuns.size > 0 || narrationDrains.size > 0;
  const reportFailure = (error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error');
  const runIdFrom = (event: unknown): string | undefined =>
    typeof event === 'object' && event !== null && 'runId' in event && typeof event.runId === 'string'
      ? event.runId
      : undefined;
  const live = new LiveVoiceController({
    host: broker.live,
    clock,
    manualState: () => manual.state,
    contextText: () => `Session ${execution.sessionId}. Workspace ${execution.repoRoot}.`,
    isBusy: () => nativeRuns.size > 0,
    send: (text, intent) => deliver(text, intent === 'follow-up'),
    onActivationStateChange: changed,
  });
  const mode = new VoiceModeController({ legacy, live, getMode: () => load().voice?.mode ?? 'legacy' });
  const waitForCapture = (): Promise<void> => {
    if (mode.state !== 'starting') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        activationWaiters.delete(wake);
        reject(new Error('Autonomous voice did not become ready within 60 seconds.'));
      }, 60_000);
      const wake = () => {
        if (mode.state === 'starting') return;
        clearTimeout(timer);
        activationWaiters.delete(wake);
        resolve();
      };
      activationWaiters.add(wake);
      wake();
    });
  };
  const registry = createDoomVoiceToolsService(randomUUID());
  const tools = registry.bindSession(execution.sessionId);
  const select = async (enabled: boolean) => {
    const modes = (host.context.selection.state?.['minor-mode'] ?? []).filter((id) => id !== DOOM_VOICE_AUTO_MODE_ID);
    await host.changeSelection({
      axis: 'state',
      key: 'minor-mode',
      values: enabled ? [...modes, DOOM_VOICE_AUTO_MODE_ID] : modes,
    });
  };
  const unregister = ownership.register({
    label: execution.sessionId,
    eligible: true,
    controller: {
      get state() {
        return mode.state;
      },
      get activationError() {
        return mode.activationError;
      },
      async activateVoice() {
        if (load().voice?.mode === 'live')
          throw new Error('Live Voice uses the host-global companion, not session media.');
        await mode.activate(autoUi);
        try {
          if (mode.state === 'starting' || mode.state === 'active') await select(true);
          await waitForCapture();
        } catch (error) {
          await mode.deactivate(autoUi).catch(() => undefined);
          throw error;
        }
        tools.setActive(mode.state === 'active');
      },
      async deactivateVoice(reason) {
        if (reason !== 'handoff') {
          voiceGeneration += 1;
          ownership.cancelPending();
        }
        await mode.deactivate(autoUi);
        tools.setActive(false);
        await select(false);
      },
    },
  });
  const bridge = new SessionVoiceOwnershipBridge(
    ownership,
    broker,
    clock,
    250,
    (error) => notify(String(error), 'error'),
    hasSourceWork,
  );
  const globalRequest = async (action?: GlobalLiveControl['action'], sessionId?: string): Promise<GlobalLiveStatus> => {
    if (!requestApi) throw new Error('The host-global Live Voice service is unavailable.');
    const response = await requestApi(
      { scope: 'global' },
      'voice',
      new Request(
        `http://voice.internal/live/${action === undefined ? 'status' : 'control'}`,
        action === undefined
          ? undefined
          : {
              method: 'POST',
              body: JSON.stringify({
                action,
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(action === 'activate' ? {} : { expectedSourceSessionId: execution.sessionId }),
              }),
            },
      ),
    );
    const value = (await response.json()) as GlobalLiveStatus & { error?: string };
    if (!response.ok) throw new Error(value.error ?? `Global Live Voice returned HTTP ${String(response.status)}.`);
    return value;
  };
  const status = async () => {
    const selectedGlobal = liveAgent.selectedRoute !== undefined;
    const liveStatus =
      load().voice?.mode === 'live' && (!selectedGlobal || liveAgent.nativeTransferAllowed)
        ? await globalRequest()
        : undefined;
    return {
      state: selectedGlobal
        ? 'active'
        : liveStatus
          ? liveStatus.activeSessionId === execution.sessionId
            ? liveStatus.state
            : 'disabled'
          : mode.state,
      mode: selectedGlobal || liveStatus ? 'live' : mode.selectedMode,
      manual: manual.state,
      muted: liveStatus?.muted ?? mode.microphoneMuted,
      ...((liveStatus?.error ?? mode.activationError) ? { error: liveStatus?.error ?? mode.activationError } : {}),
    };
  };
  const control = async (action: string, target?: number, revision?: string) => {
    host.assertActive();
    if (liveAgent.selectedRoute && !liveAgent.nativeTransferAllowed && action !== 'status')
      throw new Error('Use the owner browser controls to manage a paired Live Voice route.');
    if (action === 'manual') {
      if (mode.state !== 'disabled') throw new Error('Stop autonomous voice before manual dictation.');
      // Manual capture also needs the browser attached, without activating autonomous capture.
      await manual.toggle(manualUi);
    } else if (load().voice?.mode === 'live' && mode.state === 'disabled') {
      if (action === 'activate') {
        config();
        await globalRequest('activate', execution.sessionId);
      } else if (action === 'deactivate') await globalRequest('end');
      else if (action === 'mute' || action === 'unmute' || action === 'interrupt') await globalRequest(action);
      else if (action === 'transfer')
        throw new Error('Global Live Voice transfer requires a current, revision-bound agent target.');
      else if (action !== 'status') throw new Error(`Unknown voice action: ${action}`);
    } else if (action === 'activate') {
      config();
      ownership.requestActivation();
      await bridge.synchronize();
    } else if (action === 'deactivate') {
      voiceGeneration += 1;
      ownership.cancelPending();
      await mode.deactivate(autoUi);
      tools.setActive(false);
      await select(false);
      await bridge.synchronize();
    } else if (action === 'mute' || action === 'unmute') mode.setMicrophoneMuted(action === 'mute');
    else if (action === 'interrupt') mode.interruptSpeech();
    else if (action === 'transfer') {
      if (!target || !revision || !ownership.handoff(target, revision))
        throw new Error('Choose a target from the current revision-bound Voice catalog.');
      await bridge.synchronize();
    } else if (action !== 'status') throw new Error(`Unknown voice action: ${action}`);
    return status();
  };
  owner = defineMinorMode<void>({
    descriptor: {
      source: SOURCE,
      id: DOOM_VOICE_AUTO_MODE_ID,
      label: 'Voice',
      description: 'Browser voice capture and server transcription.',
      order: 30,
      actions: [
        {
          id: 'activate',
          label: 'Autonomous voice',
          description: 'Start continuous browser capture.',
          contexts: ['headless'],
          parameters: [],
        },
        {
          id: 'deactivate',
          label: 'Stop autonomous voice',
          description: 'Stop capture and narration.',
          contexts: ['headless'],
          parameters: [],
        },
      ],
    },
    state: () => ({
      activation: liveAgent.selectedRoute
        ? 'active'
        : mode.state === 'disabled'
          ? 'inactive'
          : mode.state === 'active'
            ? 'active'
            : mode.state === 'starting'
              ? 'activating'
              : 'deactivating',
      condition: liveAgent.selectedRoute ? 'ready' : mode.activationError ? 'failed' : 'ready',
      detail: liveAgent.selectedRoute ? 'Live Voice agent route selected.' : (mode.activationError ?? mode.state),
      actions: [
        { id: 'activate', enabled: mode.state === 'disabled' && !liveAgent.selectedRoute },
        { id: 'deactivate', enabled: mode.state !== 'disabled' || liveAgent.nativeTransferAllowed },
      ],
    }),
    async handleAction(_runtime, action, _args, context) {
      context.signal.throwIfAborted();
      await control(action);
      return { message: `Voice ${action} requested.` };
    },
  }).createOwner(undefined);
  const result = (value: unknown) => ({
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
  });
  /**
   * A voice capability the user switched off refuses the call.
   *
   * Registration gating is not containment: these tools are registered for the
   * whole session and their condition tracks the minor-mode selection, not the
   * controller. Mirrors the Pi-side refusal in services/narrationTool.
   */
  const refusal = (code: VoiceToolErrorCode, message: string) => ({
    content: [{ type: 'text' as const, text: message }],
    details: { outcome: 'failed', error: { code, message, retryable: true } },
    isError: true,
  });
  const voiceInactive = () => {
    if (closed) return refusal(VOICE_TOOL_ERROR_CODE.sessionShutdown, 'The Voice session is shutting down.');
    if (mode.state !== 'active') return refusal(VOICE_TOOL_ERROR_CODE.inactive, 'Autonomous Voice is not active.');
    return undefined;
  };
  const transferGlobal = async (target: number, revision: string) => {
    if (closed) return refusal(VOICE_TOOL_ERROR_CODE.sessionShutdown, 'The Voice session is shutting down.');
    const route = liveAgent.selectedRoute;
    const catalog = liveAgent.selectedCatalog;
    if (!route || !catalog)
      return refusal(VOICE_TOOL_ERROR_CODE.inactive, 'This Pi agent no longer owns global Live Voice.');
    if (!liveAgent.nativeTransferAllowed)
      return refusal(VOICE_TOOL_ERROR_CODE.inactive, 'Use the owner browser controls to transfer a paired Pi agent.');
    if (
      !Number.isSafeInteger(target) ||
      target < 1 ||
      revision !== catalog.revision ||
      !catalog.targets.some((item) => item.order === target)
    )
      return refusal(VOICE_TOOL_ERROR_CODE.staleCatalog, 'Choose a target from the current Live Voice catalog.');
    if (!requestApi || !hubToken)
      return refusal(VOICE_TOOL_ERROR_CODE.hostUnavailable, 'The global Live Voice host is unavailable.');
    try {
      const response = await requestApi(
        { scope: 'global' },
        'voice',
        new Request('http://voice.internal/live/native-transfer', {
          method: 'POST',
          headers: { authorization: `Bearer ${hubToken}` },
          body: JSON.stringify({
            sourceSessionId: execution.sessionId,
            activationId: route.activationId,
            routeGeneration: route.routeGeneration,
            sessionIncarnation: route.sessionIncarnation,
            ordinal: target,
            catalogRevision: revision,
          }),
        }),
      );
      if (!response.ok) {
        const failure: unknown = await response.json().catch(() => undefined);
        const message =
          typeof failure === 'object' && failure !== null && 'error' in failure && typeof failure.error === 'string'
            ? failure.error
            : `Global Live Voice returned HTTP ${String(response.status)}.`;
        return refusal(
          response.status === 409 ? VOICE_TOOL_ERROR_CODE.staleCatalog : VOICE_TOOL_ERROR_CODE.hostUnavailable,
          message,
        );
      }
      return result('Voice handoff requested. The server switches agent routes after this turn settles.');
    } catch {
      return refusal(
        VOICE_TOOL_ERROR_CODE.hostUnavailable,
        'Voice handoff status is uncertain. Check Live Voice before retrying.',
      );
    }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    liveAgent.close();
    voiceGeneration += 1;
    ownership.cancelPending();
    nativeRuns.clear();
    narrationToolRuns.clear();
    for (const registration of toolRegistrations) registration.dispose();
    toolRegistrations = [];
    bridge.stop();
    unregister();
    tools.dispose();
    registry.dispose();
    try {
      await Promise.all([mode.shutdown(autoUi), manual.shutdown(manualUi)]);
    } finally {
      broker.close();
      execution.client.setStatus('doom-voice', undefined);
    }
  };
  const exposedTools: import('@agimon-ai/doompi-core/headless').DoomHeadlessTool[] = [
    {
      when,
      name: 'describe_voice_tools',
      description: 'Describe available voice capabilities.',
      parameters: VoiceToolDescribeInputSchema,
      async execute(_id: string, input: unknown) {
        tools.setActive(mode.state === 'active');
        return result(tools.describe(input as VoiceToolDescribeInput));
      },
    },
    {
      when,
      name: 'use_voice_tools',
      description: 'Invoke registered voice capabilities.',
      parameters: VoiceToolUseInputSchema,
      async execute(_id, input, signal) {
        tools.setActive(mode.state === 'active');
        return result(await tools.useVoiceTools(input as VoiceToolUseInput, execution, { signal }));
      },
    },
    {
      when,
      name: 'narrate',
      description: 'Speak a response through the browser.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(toolCallId, input, signal) {
        const refused = voiceInactive();
        if (refused) return refused;
        const runId = narrationToolRuns.get(toolCallId);
        const run = runId === undefined ? undefined : nativeRuns.get(runId);
        if (run) run.narrationAttempted = true;
        const outcome = await mode.narrateAgent((input as { text: string }).text, signal);
        if (run && outcome === 'completed') run.narrationCompleted = true;
        return result(outcome);
      },
    },
    {
      when,
      name: 'transfer_voice',
      get description() {
        const globalCatalog = liveAgent.selectedCatalog;
        const snapshot = globalCatalog ?? ownership.snapshot();
        const targets = snapshot.targets.map((target) => `${String(target.order)}. ${target.label}`).join('\n');
        const revision = 'revision' in snapshot ? snapshot.revision : (snapshot.catalogRevision ?? '(unavailable)');
        return `Transfer voice using catalog revision ${revision}.\n${targets || '(no eligible targets)'}`;
      },
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'integer', minimum: 1 },
          revision: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['target', 'revision'],
        additionalProperties: false,
      },
      async execute(_id: string, input: unknown) {
        const transfer = input as { target: number; revision: string };
        if (closed) return refusal(VOICE_TOOL_ERROR_CODE.sessionShutdown, 'The Voice session is shutting down.');
        if (liveAgent.selectedRoute) return transferGlobal(transfer.target, transfer.revision);
        const refused = voiceInactive();
        if (refused) return refused;
        return result(await control('transfer', transfer.target, transfer.revision));
      },
    },
  ];
  return {
    tools: exposedTools,
    services: [
      serverMinorModes([owner]),
      ...(peerAgents && hubToken
        ? [() => registerVoicePeerAgent(peerAgents, execution.sessionId, liveAgent, hubToken)]
        : []),
      (context) => {
        context.plugin((providerContext) => {
          providerContext.provide(DOOM_VOICE_TOOLS_SERVICE, registry);
        });
      },
    ],
    methods: [
      defineServerMethod(voiceControlMethod, ({ action, target, revision }) => control(action, target, revision)),
    ],
    api: [
      {
        basePath: VOICE_API_BASE_PATH,
        start: () => ({
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === '/live/agent' || path.startsWith('/live/agent/')) return liveAgent.fetch(request);
            if (request.method === 'GET' && path === '/status') {
              try {
                return Response.json({
                  ...(await status()),
                  media: broker.readiness(),
                  readiness: voiceReadiness(execution.repoRoot, homeDirectory, execution.environment),
                });
              } catch (error) {
                return Response.json({ error: String(error) }, { status: 503 });
              }
            }
            if (request.method === 'POST' && path === '/control') {
              try {
                const body: unknown = await request.json();
                if (!Check(voiceControlMethod.input, body)) throw new Error('Invalid voice control request.');
                return Response.json(await control(body.action, body.target, body.revision));
              } catch (error) {
                return Response.json({ error: String(error) }, { status: 409 });
              }
            }
            return new Response(null, { status: 404 });
          },
          close() {},
        }),
      },
    ],
    onStart() {
      bridge.start();
      if (host.context.selection.state?.['minor-mode']?.includes(DOOM_VOICE_AUTO_MODE_ID))
        ownership.requestActivation();
    },
    onDispose: close,
    onStop: close,
    resources: [
      {
        when,
        name: 'doompi-use-voice',
        kind: 'skill',
        read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-voice/SKILL.md'),
      },
    ],
    commands: [
      {
        name: 'voice',
        description: 'Toggle manual dictation into the composer.',
        execute: async () => {
          await control('manual');
        },
      },
      {
        name: 'voice-auto',
        description: 'Control autonomous voice: on, off, mute, unmute, interrupt.',
        execute: async (args: string) => {
          await control(
            ({ on: 'activate', off: 'deactivate' } as Record<string, string>)[args.trim()] ??
              (args.trim() || (mode.state === 'disabled' ? 'activate' : 'deactivate')),
          );
        },
      },
    ],
    hooks: [
      {
        event: 'agent_start',
        handle(event) {
          liveAgent.onRunStart(event);
          const runId = runIdFrom(event);
          if (!runId || closed || mode.state !== 'active' || nativeRuns.has(runId)) return;
          // A resumed native run has the same runId. Prompt composition is not a run start.
          nativeRuns.set(runId, {
            runId,
            generation: voiceGeneration,
            narrationAttempted: false,
            narrationCompleted: false,
          });
        },
      },
      {
        event: 'turn_end',
        handle(event) {
          liveAgent.onTurnEnd(event);
          const run = nativeRuns.get(runIdFrom(event) ?? '');
          if (!run || run.generation !== voiceGeneration) return;
          const turn = event as {
            turnId?: string;
            message?: { role?: string; stopReason?: string; content?: Array<{ type: string; text?: string }> };
          };
          if (turn.message?.role !== 'assistant' || turn.message.stopReason === 'toolUse') return;
          run.turnId = turn.turnId;
          run.finalText =
            turn.message.content
              ?.filter((part) => part.type === 'text')
              .map((part) => part.text ?? '')
              .join('') ?? '';
        },
      },
      {
        event: 'tool_execution_start',
        handle(event) {
          const start = event as { toolCallId?: string; toolName?: string };
          const runId = runIdFrom(event);
          if (start.toolName === 'narrate' && start.toolCallId && runId && nativeRuns.has(runId)) {
            narrationToolRuns.set(start.toolCallId, runId);
          }
        },
      },
      {
        event: 'agent_settled',
        handle(event) {
          liveAgent.onSettled(event);
          const run = nativeRuns.get(runIdFrom(event) ?? '');
          if (!run || run.generation !== voiceGeneration) return;
          nativeRuns.delete(run.runId);
          for (const [callId, runId] of narrationToolRuns) if (runId === run.runId) narrationToolRuns.delete(callId);
          // Native drive awaits settled hooks. Own the Voice response and physical
          // playback separately so capture and another native prompt cannot deadlock.
          const draining = Promise.resolve()
            .then(async () => {
              if (closed || run.generation !== voiceGeneration || mode.state !== 'active') return;
              if (mode.selectedMode === 'live') {
                await live.publishAgentResult(`${run.runId}:${run.turnId ?? 'final'}`, run.finalText);
                return;
              }
              if (!run.narrationAttempted && run.finalText) {
                const outcome = await mode.narrateFallback(run.finalText);
                run.narrationCompleted = outcome === 'completed';
              }
              if (ownership.snapshot().handoff && !run.narrationCompleted) {
                ownership.cancelPending();
                notify('Voice transfer was cancelled because source narration did not complete.', 'warning');
              }
            })
            .catch((error: unknown) => {
              ownership.cancelPending();
              reportFailure(error);
            })
            .finally(() => {
              narrationDrains.delete(draining);
              if (!closed && run.generation === voiceGeneration && !hasSourceWork() && ownership.snapshot().handoff)
                void bridge.synchronize().catch(reportFailure);
            });
          narrationDrains.add(draining);
        },
      },
      { event: 'session_shutdown', handle: close },
    ],
  };
}
