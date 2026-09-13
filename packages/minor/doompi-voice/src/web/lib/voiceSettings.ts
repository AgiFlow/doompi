import type { SettingsSectionContribution } from '@agimon-ai/doompi-core/web';

export const voiceSettingsSection: SettingsSectionContribution = {
  id: 'voice',
  label: 'voice',
  detail: 'Transcription, autonomous capture, and narration.',
  order: 60,
  fields: [
    {
      id: 'mode',
      label: 'Autonomous mode',
      kind: 'select',
      keyPath: ['voice', 'mode'],
      options: ['legacy', 'live'].map((value) => ({ value, label: value })),
    },
    {
      id: 'engine',
      label: 'Transcriber',
      kind: 'select',
      keyPath: ['voice', 'engine'],
      options: ['auto', 'whisper-cpp', 'openai-whisper', 'mlx-whisper'].map((value) => ({ value, label: value })),
    },
    { id: 'language', label: 'Language', kind: 'text', keyPath: ['voice', 'language'], placeholder: 'en' },
    ...['whisper-cpp', 'openai-whisper', 'mlx-whisper'].flatMap((engine) => [
      {
        id: `${engine}-binary`,
        label: `${engine} executable`,
        kind: 'text' as const,
        keyPath: ['voice', 'adapters', engine, 'binary'],
      },
      {
        id: `${engine}-model`,
        label: `${engine} model`,
        kind: 'text' as const,
        keyPath: ['voice', 'adapters', engine, 'model', engine === 'whisper-cpp' ? 'path' : 'id'],
      },
    ]),
    {
      id: 'correction-model',
      label: 'Correction and narration model',
      kind: 'select',
      optionsFrom: 'models',
      keyPath: ['voice', 'autoCapture', 'model'],
    },
    {
      id: 'endpoint',
      label: 'Silence endpoint (ms)',
      kind: 'number',
      keyPath: ['voice', 'autoCapture', 'utteranceIdleMs'],
    },
    {
      id: 'transcription-timeout',
      label: 'Transcription timeout (ms)',
      kind: 'number',
      keyPath: ['voice', 'autoCapture', 'transcriptionTimeoutMs'],
    },
    {
      id: 'narration-engine',
      label: 'Narration engine',
      kind: 'select',
      keyPath: ['voice', 'autoCapture', 'tts', 'engine'],
      options: [{ value: 'macos-say', label: 'macOS say' }],
    },
    {
      id: 'narration-voice',
      label: 'Narration voice',
      kind: 'text',
      keyPath: ['voice', 'autoCapture', 'tts', 'voice'],
    },
    { id: 'narration-rate', label: 'Narration rate', kind: 'number', keyPath: ['voice', 'autoCapture', 'tts', 'rate'] },
  ],
};
