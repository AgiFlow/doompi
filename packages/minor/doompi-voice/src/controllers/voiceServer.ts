import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { loadDoomConfig, resolveVoiceConfig } from '@agimon-ai/doompi-config';
import type { DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { defineServerMethod, type DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';
import { defineMinorMode, serverMinorModes, type MinorModeOwner } from '@agimon-ai/doompi-minor-mode';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';
import { Check } from 'typebox/value';

import { DOOM_VOICE_AUTO_MODE_ID, DOOM_VOICE_TOOLS_SERVICE } from '../constants/voiceTools';
import { voiceControlMethod } from '../schemas/voiceControl';
import {
  VoiceToolDescribeInputSchema,
  VoiceToolUseInputSchema,
  type VoiceToolDescribeInput,
  type VoiceToolUseInput,
} from '../schemas/voiceTools';
import { ClientTtsAdapter } from '../services/clientMedia';
import { VoiceCommandCorrector } from '../services/commandCorrection';
import { VoiceTurnFallbackNarrator } from '../services/fallbackNarration';
import {
  ExecutableResolver,
  MacOsSayPcmSynthesizer,
  NodeBinaryProcessSpawner,
  SystemClock,
} from '../services/infrastructure';
import { SessionVoiceOwnership, SessionVoiceOwnershipBridge } from '../services/sessionVoiceOwnership';
import { VoiceTranscriptAdjudicator } from '../services/transcriptAdmission';
import { readVoicePrompt } from '../services/voicePrompt';
import { voiceReadiness } from '../services/voiceReadiness';
import { createDoomVoiceToolsService } from '../services/voiceTools';
import { VoiceWorkerAutoCaptureController } from '../services/voiceWorkerAutoCaptureController';
import { VoiceWorkerClient } from '../services/voiceWorkerClient';
import { VoiceWorkerSessionController } from '../services/voiceWorkerSessionController';
import type { AutoCaptureUi, VoiceUi } from '../types';
import type { VoiceMediaBroker } from './clientMediaApi';
import { LiveVoiceController } from './liveVoiceController';
import { VoiceModeController } from './voiceModeController';

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
  const changed = () => {
    owner?.publish();
    if (
      !closed &&
      mode.state === 'disabled' &&
      host.context.selection.state?.['minor-mode']?.includes(DOOM_VOICE_AUTO_MODE_ID)
    )
      void select(false).catch((error: unknown) => notify(String(error), 'error'));
    if (mode.state === 'active' && toolRegistrations.length === 0)
      toolRegistrations = exposedTools.map((tool) => host.registerTool(tool));
    if (mode.state !== 'active') {
      for (const registration of toolRegistrations) registration.dispose();
      toolRegistrations = [];
    }
  };
  const deliver = async (text: string, queued = false): Promise<void> => {
    host.assertActive();
    if (!execution.session.admitPrompt) throw new Error('The session cannot admit voice prompts.');
    const activity = await execution.session.activity();
    await execution.session.admitPrompt(text, queued || !activity.isIdle ? 'followUp' : 'prompt');
  };
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
  let busy = false;
  const live = new LiveVoiceController({
    host: broker.live,
    clock,
    manualState: () => manual.state,
    contextText: () => `Session ${execution.sessionId}. Workspace ${execution.repoRoot}.`,
    isBusy: () => busy,
    send: (text, intent) => deliver(text, intent === 'follow-up'),
    onActivationStateChange: changed,
  });
  const mode = new VoiceModeController({ legacy, live, getMode: () => load().voice?.mode ?? 'legacy' });
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
        await mode.activate(autoUi);
        if (mode.state === 'starting' || mode.state === 'active') await select(true);
        tools.setActive(mode.state === 'active');
      },
      async deactivateVoice() {
        await mode.deactivate(autoUi);
        tools.setActive(false);
        await select(false);
      },
    },
  });
  const bridge = new SessionVoiceOwnershipBridge(ownership, broker, clock, 250, (error) =>
    notify(String(error), 'error'),
  );
  const status = () => ({
    state: mode.state,
    mode: mode.selectedMode,
    manual: manual.state,
    muted: mode.microphoneMuted,
    ...(mode.activationError ? { error: mode.activationError } : {}),
  });
  const control = async (action: string, target?: number) => {
    host.assertActive();
    if (action === 'manual') {
      if (mode.state !== 'disabled') throw new Error('Stop autonomous voice before manual dictation.');
      // Manual capture also needs the browser attached, without activating autonomous capture.
      await manual.toggle(manualUi);
    } else if (action === 'activate') {
      config();
      ownership.requestActivation();
      await bridge.synchronize();
    } else if (action === 'deactivate') {
      await mode.deactivate(autoUi);
      tools.setActive(false);
      await select(false);
      await bridge.synchronize();
    } else if (action === 'mute' || action === 'unmute') mode.setMicrophoneMuted(action === 'mute');
    else if (action === 'interrupt') mode.interruptSpeech();
    else if (action === 'transfer') {
      if (!target || !ownership.handoff(target)) throw new Error('Choose an available voice session target.');
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
      activation:
        mode.state === 'disabled'
          ? 'inactive'
          : mode.state === 'active'
            ? 'active'
            : mode.state === 'starting'
              ? 'activating'
              : 'deactivating',
      condition: mode.activationError ? 'failed' : 'ready',
      detail: mode.activationError ?? mode.state,
      actions: [
        { id: 'activate', enabled: mode.state === 'disabled' },
        { id: 'deactivate', enabled: mode.state !== 'disabled' },
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
  let narrated = false;
  let finalText = '';
  const close = async () => {
    if (closed) return;
    closed = true;
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
      async execute(_id, input, signal) {
        narrated = true;
        return result(await mode.narrateAgent((input as { text: string }).text, signal));
      },
    },
    {
      when,
      name: 'transfer_voice',
      description: 'Transfer voice to an available session by its catalog order.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'integer', minimum: 1 } },
        required: ['target'],
        additionalProperties: false,
      },
      async execute(_id: string, input: unknown) {
        return result(await control('transfer', (input as { target: number }).target));
      },
    },
  ];
  return {
    services: [
      serverMinorModes([owner]),
      (context) => {
        context.provide(DOOM_VOICE_TOOLS_SERVICE, registry);
      },
    ],
    methods: [defineServerMethod(voiceControlMethod, ({ action, target }) => control(action, target))],
    api: [
      {
        basePath: 'voice',
        start: () => ({
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (request.method === 'GET' && path === '/status')
              return Response.json({
                ...status(),
                media: broker.readiness(),
                readiness: voiceReadiness(execution.repoRoot, homeDirectory, execution.environment),
              });
            if (request.method === 'POST' && path === '/control') {
              try {
                const body: unknown = await request.json();
                if (!Check(voiceControlMethod.input, body)) throw new Error('Invalid voice control request.');
                return Response.json(await control(body.action, body.target));
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
    resources: [{ when, name: 'doompi-use-voice', kind: 'skill', read: readVoicePrompt }],
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
        event: 'before_agent_start',
        handle() {
          busy = true;
          narrated = false;
          finalText = '';
        },
      },
      {
        event: 'message_end',
        handle(event) {
          const message = event.message as
            | { role?: string; content?: Array<{ type: string; text?: string }> }
            | undefined;
          if (message?.role === 'assistant')
            finalText =
              message.content
                ?.filter((part) => part.type === 'text')
                .map((part) => part.text ?? '')
                .join('') ?? '';
        },
      },
      {
        event: 'agent_settled',
        async handle() {
          busy = false;
          if (finalText && mode.state === 'active') {
            if (mode.selectedMode === 'live') await live.publishAgentResult(String(clock.now()), finalText);
            else if (!narrated) await mode.narrateFallback(finalText);
          }
        },
      },
      { event: 'session_shutdown', handle: close },
    ],
  };
}
