import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import { describe, expect, it, vi } from 'vitest';
import { ClientPcmAudioRecorder, ClientTtsAdapter } from '../src/adapters/audio/clientMedia.ts';
import { PCM_FRAME_BYTES } from '../src/services/pcm.ts';
import type { IClock, IVoiceMediaHostConnection, TimerHandle, VoiceMediaAudioPoll } from '../src/types/index.ts';
import type { VoiceMediaPlaybackResult } from '../src/types/clientMedia.ts';

const config: ResolvedVoiceConfig = {
  engine: 'whisper-cpp',
  language: 'auto',
  recorder: { device: 'unused' },
  adapters: { 'whisper-cpp': { model: { path: '/model.bin' } } },
};

class MediaConnection implements IVoiceMediaHostConnection {
  public readonly startedCaptures: string[] = [];
  public readonly stoppedCaptures: string[] = [];
  public readonly playbacks: { playbackId: string; text: string; voice?: string; rate?: number }[] = [];
  public readonly stoppedPlaybacks: string[] = [];
  public capturePolls: VoiceMediaAudioPoll[] = [];
  public playbackResult: VoiceMediaPlaybackResult | undefined;
  public playbackDelivery: 'client' | 'streamed' = 'client';
  public readonly playbackAudio: Buffer[] = [];
  public playbackAudioError: string | undefined;

  public async startCapture(captureId: string): Promise<void> {
    this.startedCaptures.push(captureId);
  }
  public async readCapture(): Promise<VoiceMediaAudioPoll> {
    return this.capturePolls.shift() ?? { pcm: Buffer.alloc(0), state: 'stopped' };
  }
  public async stopCapture(captureId: string): Promise<void> {
    this.stoppedCaptures.push(captureId);
  }
  public async abortCapture(): Promise<void> {}
  public async startPlayback(request: {
    playbackId: string;
    text: string;
    voice?: string;
    rate?: number;
  }): Promise<'client' | 'streamed'> {
    this.playbacks.push(request);
    return this.playbackDelivery;
  }
  public async sendPlaybackAudio(_playbackId: string, pcm: Buffer): Promise<void> {
    this.playbackAudio.push(pcm);
  }
  public async sealPlaybackAudio(_playbackId: string, error?: string): Promise<void> {
    this.playbackAudioError = error;
  }
  public async readPlayback(): Promise<VoiceMediaPlaybackResult | undefined> {
    return this.playbackResult;
  }
  public async stopPlayback(playbackId: string): Promise<void> {
    this.stoppedPlaybacks.push(playbackId);
  }
  public async abortPlayback(): Promise<void> {}
}

const clock: IClock = {
  now: vi.fn(() => 100),
  setInterval: vi.fn(() => ({}) as TimerHandle),
  setTimeout: vi.fn(() => ({}) as TimerHandle),
  clear: vi.fn(),
};

describe('agent-side client media adapters', () => {
  it('frames client PCM identically for one-shot and autonomous worker captures', async () => {
    const connection = new MediaConnection();
    const input = Buffer.alloc(PCM_FRAME_BYTES + 8, 0x4a);
    connection.capturePolls = [
      { pcm: input.subarray(0, 111), state: 'active' },
      { pcm: input.subarray(111), state: 'stopped' },
    ];
    const frames: Buffer[] = [];
    const recording = new ClientPcmAudioRecorder(connection).start(config, (frame) => frames.push(frame));

    expect((await recording.completion).code).toBe(0);
    expect(frames).toEqual([Buffer.alloc(PCM_FRAME_BYTES, 0x4a)]);
    expect(await recording.stop()).toEqual(Buffer.alloc(8, 0x4a));
    expect(connection.stoppedCaptures).toEqual(connection.startedCaptures);
  });

  it('settles narration only after the client reports browser playback completion', async () => {
    const connection = new MediaConnection();
    connection.playbackResult = { playbackId: 'placeholder', outcome: 'completed' };
    const playback = new ClientTtsAdapter(connection, clock).speak({
      id: 4,
      kind: 'final',
      text: '  Browser narration.  ',
      config: { engine: 'macos-say', voice: 'Samantha', rate: 190 },
    });
    const result = await playback.completion;

    expect(connection.playbacks[0]).toMatchObject({ text: 'Browser narration.', voice: 'Samantha', rate: 190 });
    expect(result.outcome).toBe('completed');
    expect(result.process.code).toBe(0);
  });

  it('synthesizes and uploads PCM before awaiting remote physical playback settlement', async () => {
    const connection = new MediaConnection();
    connection.playbackDelivery = 'streamed';
    connection.playbackResult = { playbackId: 'placeholder', outcome: 'completed' };
    const pcm = Buffer.alloc(70_000, 0x4a);
    const synthesizer = { synthesize: vi.fn(async () => pcm) };
    const playback = new ClientTtsAdapter(connection, clock, synthesizer).speak({
      id: 5,
      kind: 'final',
      text: 'Remote narration.',
      config: { engine: 'macos-say' },
    });

    await expect(playback.completion).resolves.toMatchObject({ outcome: 'completed' });
    expect(synthesizer.synthesize).toHaveBeenCalledOnce();
    expect(connection.playbackAudio.map((chunk) => chunk.byteLength)).toEqual([65_536, 4_464]);
    expect(Buffer.concat(connection.playbackAudio)).toEqual(pcm);
    expect(connection.playbackAudioError).toBeUndefined();
  });
});
