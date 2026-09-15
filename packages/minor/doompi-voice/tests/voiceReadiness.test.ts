import { describe, expect, it, vi } from 'vitest';

vi.mock('@agimon-ai/doompi-config', () => ({
  loadDoomConfigLayers: (_repoRoot: string | undefined, homeDirectory: string) => {
    if (homeDirectory === '/unreadable') throw new Error('Unreadable Voice config.');
    if (homeDirectory === '/string-error') throw 'Unreadable Voice config string.';
    if (homeDirectory === '/configured') return { effective: { voice: { mode: 'live' } } };
    if (homeDirectory === '/legacy') return { effective: { voice: {} } };
    return { effective: {} };
  },
  resolveVoiceConfig: () => ({ recorder: { binary: 'ffmpeg' }, autoCapture: { model: 'voice-model' } }),
}));
vi.mock('../src/services/infrastructure', () => ({
  ExecutableResolver: class {
    resolve() {
      return '/usr/bin/ffmpeg';
    }
  },
  NodeProcessSpawner: class {},
}));
vi.mock('../src/services/whisper', () => ({
  WhisperCppAdapter: class {},
  OpenAiWhisperAdapter: class {},
  MlxWhisperAdapter: class {},
  TranscriberRegistry: class {
    select() {
      return { adapter: { engine: 'whisper-cpp' } };
    }
  },
}));

import { voiceReadiness } from '../src/services/voiceReadiness';

describe('voiceReadiness', () => {
  it('reports an actionable result when Voice has not been configured', () => {
    expect(voiceReadiness('/repo', '/home')).toEqual({
      configured: false,
      transcription: false,
      error: 'Configure Voice in settings before starting capture.',
    });
  });

  it('returns configuration errors as failed readiness', () => {
    expect(voiceReadiness('/repo', '/unreadable')).toEqual({
      configured: true,
      transcription: false,
      error: 'Unreadable Voice config.',
    });
  });

  it('reports the selected engine and explicit mode when local dependencies are ready', () => {
    expect(voiceReadiness('/repo', '/configured', { PATH: '/usr/bin' })).toEqual({
      configured: true,
      transcription: true,
      engine: 'whisper-cpp',
      mode: 'live',
      correctionModel: 'voice-model',
    });
  });

  it('uses the legacy mode default and stringifies non-Error failures', () => {
    expect(voiceReadiness('/repo', '/legacy')).toMatchObject({ mode: 'legacy', transcription: true });
    expect(voiceReadiness('/repo', '/string-error')).toEqual({
      configured: true,
      transcription: false,
      error: 'Unreadable Voice config string.',
    });
  });
});
