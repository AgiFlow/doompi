import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';
import { type DoomHeadlessCommand, type DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';
import { defineMinorMode, type MinorModeOwner, type MinorModeState } from '@agimon-ai/doompi-minor-mode';
import { DOOM_VOICE_AUTO_MODE_ID } from '../constants/voiceTools';
import { readVoicePrompt } from '../services/voicePrompt';

const SOURCE = '@agimon-ai/doompi-voice';
const VOICE_TOOL_NAMES = ['describe_voice_tools', 'use_voice_tools', 'narrate', 'transfer_voice'] as const;
const MEDIA_UNAVAILABLE =
  'Voice media requires an explicit client media transport. The current headless host exposes no capture, playback, or transcription transport.';

function failure(message: string): DoomHeadlessToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

import { type DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { type DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';
export function createVoiceServer(host: DoomHeadlessHostService): DoomServerSessionPlugin {
  const media = undefined;
  let modeOwner: MinorModeOwner;
  const modeSelected = (): boolean =>
    (host.context.selection.state?.['minor-mode'] ?? []).includes(DOOM_VOICE_AUTO_MODE_ID);
  const modeState = (): MinorModeState => {
    const active = modeSelected();
    return {
      activation: active ? 'active' : 'inactive',
      condition: 'ready',
      ...(active ? { detail: 'autonomous voice' } : {}),
      actions: [
        { id: 'activate', enabled: !active, ...(!active ? {} : { disabledReason: 'Voice mode is already active.' }) },
        { id: 'deactivate', enabled: active, ...(active ? {} : { disabledReason: 'Voice mode is inactive.' }) },
      ],
    };
  };
  const selectMode = async (enabled: boolean): Promise<void> => {
    const modes = (host.context.selection.state?.['minor-mode'] ?? []).filter(
      (mode) => mode !== DOOM_VOICE_AUTO_MODE_ID,
    );
    await host.changeSelection({
      axis: 'state',
      key: 'minor-mode',
      values: enabled ? [...modes, DOOM_VOICE_AUTO_MODE_ID] : modes,
    });
    modeOwner.publish();
  };
  modeOwner = defineMinorMode<void>({
    descriptor: {
      source: SOURCE,
      id: DOOM_VOICE_AUTO_MODE_ID,
      label: 'Voice',
      description: 'Autonomous voice capture with command correction and primary-agent narration.',
      order: 30,
      actions: [
        {
          id: 'activate',
          label: 'Autonomous voice',
          description: 'Start continuous capture with command correction and primary-agent narration.',
          contexts: ['headless'],
          parameters: [],
        },
        {
          id: 'deactivate',
          label: 'Stop autonomous voice',
          description: 'Stop autonomous voice capture.',
          contexts: ['headless'],
          parameters: [],
        },
      ],
    },
    state: modeState,
    async handleAction(_runtime, actionId, _argumentsValue, execution) {
      execution.signal.throwIfAborted();
      if (actionId === 'activate') {
        throw new Error(media ? 'Voice realtime execution requires a typed session transport.' : MEDIA_UNAVAILABLE);
      }
      if (actionId === 'deactivate') {
        await selectMode(false);
        return { message: 'Voice mode deactivated.' };
      }
      throw new Error(`Unknown voice mode action: ${actionId}`);
    },
  }).createOwner(undefined);
  return {
    services: [serverMinorModes([modeOwner])],
    toolRestrictions: [
      {
        when: { state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID } },
        allowedTools: [...VOICE_TOOL_NAMES],
      },
    ],
    resources: [
      {
        when: {
          state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID },
          attribution: { kind: 'minor', mode: DOOM_VOICE_AUTO_MODE_ID },
        },
        name: 'doompi-use-voice',
        kind: 'skill',
        read: readVoicePrompt,
      },
    ],
    activities: [
      {
        when: {
          state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID },
          attribution: { kind: 'minor', mode: DOOM_VOICE_AUTO_MODE_ID },
        },
        name: SOURCE,
        start() {
          if (!media) throw new Error(MEDIA_UNAVAILABLE);
          return () => undefined;
        },
      },
    ],
    tools: [
      {
        when: {
          state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID },
          attribution: { kind: 'minor', mode: DOOM_VOICE_AUTO_MODE_ID },
        },
        name: 'describe_voice_tools',
        label: 'Describe Voice tools',
        description: 'Describe the voice capabilities available to this headless session.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        executionMode: 'serial',
        async execute() {
          return media
            ? failure('Voice tool catalog requires a typed realtime session transport, which is not configured.')
            : failure(MEDIA_UNAVAILABLE);
        },
      },
      {
        when: {
          state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID },
          attribution: { kind: 'minor', mode: DOOM_VOICE_AUTO_MODE_ID },
        },
        name: 'use_voice_tools',
        label: 'Use Voice tools',
        description: 'Invoke one capability from the current voice catalog.',
        parameters: {
          type: 'object',
          properties: {
            catalogToken: { type: 'string', minLength: 1 },
            calls: { type: 'array', items: { type: 'object' } },
          },
          required: ['catalogToken', 'calls'],
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute() {
          return failure(media ? 'Voice realtime execution requires a typed session transport.' : MEDIA_UNAVAILABLE);
        },
      },
      {
        when: {
          state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID },
          attribution: { kind: 'minor', mode: DOOM_VOICE_AUTO_MODE_ID },
        },
        name: 'narrate',
        label: 'Narrate',
        description: 'Speak text through the configured voice media client.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
          required: ['text'],
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute() {
          return failure(media ? 'Narration requires a typed TTS synthesis transport.' : MEDIA_UNAVAILABLE);
        },
      },
      {
        when: {
          state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID },
          attribution: { kind: 'minor', mode: DOOM_VOICE_AUTO_MODE_ID },
        },
        name: 'transfer_voice',
        label: 'Transfer Voice',
        description: 'Transfer autonomous voice control to the selected session.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        executionMode: 'serial',
        async execute() {
          return failure(
            media ? 'Voice ownership transfer requires a typed client ownership transport.' : MEDIA_UNAVAILABLE,
          );
        },
      },
    ],
    commands: [
      {
        name: 'voice',
        description: 'Toggle one-shot manual voice dictation.',
        async execute(_args, execution) {
          await execution.client.notify({ body: MEDIA_UNAVAILABLE, level: 'error' });
        },
      },
      {
        name: 'voice-auto',
        description: 'Manage autonomous voice capture and narration.',
        async execute(_args, execution) {
          await execution.client.notify({ body: MEDIA_UNAVAILABLE, level: 'error' });
        },
      },
    ] satisfies DoomHeadlessCommand[],
    hooks: [
      {
        when: {
          state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID },
          attribution: { kind: 'minor', mode: DOOM_VOICE_AUTO_MODE_ID },
        },
        event: 'session_shutdown',
        handle: () => {
          host.context.client.setStatus(SOURCE, undefined);
        },
      },
    ],
  };
}
