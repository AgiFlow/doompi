import type {
  VoiceMediaCapture,
  VoiceMediaDevice,
  VoiceMediaPlayback,
  VoiceMediaPlaybackOutcome,
  VoiceMediaPlaybackResult,
} from '../src/types/clientMedia.ts';
import { VOICE_MEDIA_SAMPLE_RATE } from '../src/types/clientMedia.ts';

const AUDIO_BUFFER_SIZE = 4_096;
const DEFAULT_SPEECH_RATE_WPM = 180;
const MIN_SPEECH_RATE = 0.1;
const MAX_SPEECH_RATE = 10;
const PCM_MAXIMUM = 32_767;
const PCM_MINIMUM = -32_768;

/** Stateful rate conversion so chunk boundaries do not drop or duplicate time. */
export class Pcm16Resampler {
  private sourceIndex = 0;
  private nextOutputAt = 0;

  public constructor(private readonly sourceRate: number) {
    if (!Number.isFinite(sourceRate) || sourceRate <= 0) throw new Error('Audio source rate must be positive.');
  }

  public push(input: Float32Array): Uint8Array {
    const output: number[] = [];
    const sourceFramesPerOutput = this.sourceRate / VOICE_MEDIA_SAMPLE_RATE;
    for (let index = 0; index < input.length; index += 1) {
      const absoluteIndex = this.sourceIndex + index;
      while (this.nextOutputAt <= absoluteIndex) {
        const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
        output.push(sample < 0 ? Math.round(sample * -PCM_MINIMUM) : Math.round(sample * PCM_MAXIMUM));
        this.nextOutputAt += sourceFramesPerOutput;
      }
    }
    this.sourceIndex += input.length;
    const bytes = new Uint8Array(output.length * 2);
    const view = new DataView(bytes.buffer);
    output.forEach((sample, index) => view.setInt16(index * 2, sample, true));
    return bytes;
  }
}

class BrowserSpeechPlayback implements VoiceMediaPlayback {
  public readonly completion: Promise<VoiceMediaPlaybackResult>;
  private requestedOutcome: Extract<VoiceMediaPlaybackOutcome, 'stopped' | 'aborted'> | undefined;
  private settleCompletion!: (result: VoiceMediaPlaybackResult) => void;
  private settled = false;

  public constructor(
    private readonly synthesis: SpeechSynthesis,
    private readonly utterance: SpeechSynthesisUtterance,
    private readonly playbackId: string,
  ) {
    this.completion = new Promise((resolve) => {
      this.settleCompletion = resolve;
    });
    utterance.onend = () => this.settle(this.requestedOutcome ?? 'completed');
    utterance.onerror = (event) =>
      this.settle(this.requestedOutcome ?? 'failed', event.error || 'Browser speech synthesis failed.');
  }

  public stop(outcome: Extract<VoiceMediaPlaybackOutcome, 'stopped' | 'aborted'>): void {
    if (this.settled) return;
    this.requestedOutcome = outcome;
    this.synthesis.cancel();
    this.settle(outcome);
  }

  private settle(outcome: VoiceMediaPlaybackOutcome, error?: string): void {
    if (this.settled) return;
    this.settled = true;
    this.utterance.onend = null;
    this.utterance.onerror = null;
    this.settleCompletion({ playbackId: this.playbackId, outcome, ...(error ? { error } : {}) });
  }
}

export class BrowserVoiceMediaDevice implements VoiceMediaDevice {
  public readonly capabilities = {
    capture: typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined,
    playback: typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  };

  private stream: MediaStream | undefined;
  private context: AudioContext | undefined;
  private activeCapture: VoiceMediaCapture | undefined;
  private activePlayback: BrowserSpeechPlayback | undefined;

  public async startCapture(onPcm: (pcm: Uint8Array) => void): Promise<VoiceMediaCapture> {
    if (!this.capabilities.capture) throw new Error('This browser cannot capture microphone audio.');
    if (this.activeCapture !== undefined) throw new Error('Browser microphone capture is already active.');
    this.stream ??= await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.context ??= new AudioContext();
    await this.context.resume();

    const captureStream = this.stream;
    const source = this.context.createMediaStreamSource(captureStream);
    const processor = this.context.createScriptProcessor(AUDIO_BUFFER_SIZE, 1, 1);
    const muted = this.context.createGain();
    muted.gain.value = 0;
    const resampler = new Pcm16Resampler(this.context.sampleRate);
    processor.onaudioprocess = (event) => {
      const pcm = resampler.push(event.inputBuffer.getChannelData(0));
      if (pcm.byteLength > 0) onPcm(pcm);
    };
    source.connect(processor);
    processor.connect(muted);
    muted.connect(this.context.destination);

    let stopped = false;
    const capture: VoiceMediaCapture = {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        muted.disconnect();
        for (const track of captureStream.getTracks()) track.stop();
        if (this.stream === captureStream) this.stream = undefined;
        if (this.activeCapture === capture) this.activeCapture = undefined;
      },
    };
    this.activeCapture = capture;
    return capture;
  }

  public speak(request: Parameters<VoiceMediaDevice['speak']>[0]): VoiceMediaPlayback {
    if (!this.capabilities.playback) throw new Error('This browser cannot play speech narration.');
    this.activePlayback?.stop('aborted');
    const utterance = new SpeechSynthesisUtterance(request.text);
    if (request.rate !== undefined) {
      utterance.rate = Math.max(MIN_SPEECH_RATE, Math.min(MAX_SPEECH_RATE, request.rate / DEFAULT_SPEECH_RATE_WPM));
    }
    if (request.voice) {
      utterance.voice =
        window.speechSynthesis
          .getVoices()
          .find((voice) => voice.name === request.voice || voice.voiceURI === request.voice) ?? null;
    }
    const playback = new BrowserSpeechPlayback(window.speechSynthesis, utterance, request.playbackId);
    this.activePlayback = playback;
    void playback.completion.finally(() => {
      if (this.activePlayback === playback) this.activePlayback = undefined;
    });
    window.speechSynthesis.speak(utterance);
    return playback;
  }

  public async close(): Promise<void> {
    await this.activeCapture?.stop();
    this.activePlayback?.stop('aborted');
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    if (this.context !== undefined && this.context.state !== 'closed') await this.context.close();
    this.context = undefined;
  }
}
