import type { SpeechPresenceDetector } from '../src/types/clientCaptureActivity.ts';
import type {
  VoiceMediaCapabilities,
  VoiceMediaCapture,
  VoiceMediaDevice,
  VoiceMediaPlayback,
  VoiceMediaPlaybackOutcome,
  VoiceMediaPlaybackResult,
} from '../src/types/clientMedia.ts';
import { VOICE_MEDIA_SAMPLE_RATE } from '../src/types/clientMedia.ts';
import { BrowserSpeechPresenceDetector, type SpeechWorker } from './browserSpeechPresenceDetector.ts';

const AUDIO_BUFFER_SIZE = 4_096;
const AUDIO_UPLOAD_DURATION_MS = 100;
const AUDIO_WORKLET_NAME = 'doompi-voice-capture';
const DEFAULT_SPEECH_RATE_WPM = 180;
const MIN_SPEECH_RATE = 0.1;
const MAX_SPEECH_RATE = 10;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_MAXIMUM = 32_767;
const PCM_MINIMUM = -32_768;
const PCM_UPLOAD_BYTES = (VOICE_MEDIA_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * AUDIO_UPLOAD_DURATION_MS) / 1_000;
const SILENT_OUTPUT_GAIN = 1e-8;

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
  private ducked = false;
  private fadeTimer: ReturnType<typeof setInterval> | undefined;
  private restoreTimer: ReturnType<typeof setTimeout> | undefined;

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

  public duck(targetGain: number, fadeMs: number, holdMs: number): void {
    if (this.settled || this.ducked) return;
    this.ducked = true;
    const target = Math.max(0, Math.min(1, targetGain));
    this.fadeTo(target, Math.max(0, fadeMs), () => {
      this.restoreTimer = setTimeout(
        () => {
          this.restoreTimer = undefined;
          this.fadeTo(1, 600, () => {
            this.ducked = false;
          });
        },
        Math.max(0, holdMs),
      );
    });
  }

  private fadeTo(target: number, durationMs: number, completed: () => void): void {
    if (this.fadeTimer !== undefined) clearInterval(this.fadeTimer);
    this.fadeTimer = undefined;
    const start = this.utterance.volume;
    const steps = Math.max(1, Math.ceil(durationMs / 50));
    let step = 0;
    const advance = (): void => {
      step += 1;
      this.utterance.volume = start + (target - start) * Math.min(1, step / steps);
      if (step < steps) return;
      if (this.fadeTimer !== undefined) clearInterval(this.fadeTimer);
      this.fadeTimer = undefined;
      completed();
    };
    if (durationMs === 0) {
      advance();
      return;
    }
    this.fadeTimer = setInterval(advance, durationMs / steps);
  }

  private settle(outcome: VoiceMediaPlaybackOutcome, error?: string): void {
    if (this.settled) return;
    this.settled = true;
    if (this.fadeTimer !== undefined) clearInterval(this.fadeTimer);
    if (this.restoreTimer !== undefined) clearTimeout(this.restoreTimer);
    this.fadeTimer = undefined;
    this.restoreTimer = undefined;
    this.utterance.onend = null;
    this.utterance.onerror = null;
    this.settleCompletion({ playbackId: this.playbackId, outcome, ...(error ? { error } : {}) });
  }
}

export class BrowserVoiceMediaDevice implements VoiceMediaDevice {
  public readonly capabilities: VoiceMediaCapabilities = {
    capture: typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined,
    playback: typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
    captureActivity: false,
    autonomousOrchestration: false,
    playbackDucking:
      typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  };
  private stream: MediaStream | undefined;
  private context: AudioContext | undefined;
  private workletInstalled = false;
  private activeCapture: VoiceMediaCapture | undefined;
  private activePlayback: BrowserSpeechPlayback | undefined;
  private speechDetector: BrowserSpeechPresenceDetector | undefined;
  private speechPreparation: Promise<void> | undefined;

  public async prepare(): Promise<void> {
    this.speechPreparation ??= this.prepareSpeechDetector();
    await this.speechPreparation;
  }

  public createSpeechPresenceDetector(): SpeechPresenceDetector | undefined {
    return this.speechDetector;
  }

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
    const muted = this.context.createGain();
    muted.gain.value = SILENT_OUTPUT_GAIN;
    const resampler = new Pcm16Resampler(this.context.sampleRate);
    let pendingPcmChunks: Uint8Array[] = [];
    let pendingPcmBytes = 0;
    const emitPcm = (byteLength: number): void => {
      const upload = new Uint8Array(byteLength);
      let offset = 0;
      while (offset < byteLength) {
        const chunk = pendingPcmChunks[0];
        if (chunk === undefined) break;
        const accepted = Math.min(chunk.byteLength, byteLength - offset);
        upload.set(chunk.subarray(0, accepted), offset);
        offset += accepted;
        if (accepted === chunk.byteLength) pendingPcmChunks.shift();
        else pendingPcmChunks[0] = chunk.subarray(accepted);
      }
      pendingPcmBytes -= byteLength;
      onPcm(upload);
    };
    const acceptSamples = (samples: Float32Array): void => {
      const pcm = resampler.push(samples);
      if (pcm.byteLength === 0) return;
      pendingPcmChunks.push(pcm);
      pendingPcmBytes += pcm.byteLength;
      while (pendingPcmBytes >= PCM_UPLOAD_BYTES) emitPcm(PCM_UPLOAD_BYTES);
    };
    let processor: AudioNode;
    let stopProcessor: () => void;
    if (typeof AudioWorkletNode !== 'undefined' && this.context.audioWorklet !== undefined) {
      if (!this.workletInstalled) {
        await this.context.audioWorklet.addModule(
          new URL('./browserCaptureWorklet.js?no-inline', import.meta.url).href,
        );
        this.workletInstalled = true;
      }
      const worklet = new AudioWorkletNode(this.context, AUDIO_WORKLET_NAME);
      worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data instanceof Float32Array) acceptSamples(event.data);
      };
      processor = worklet;
      stopProcessor = () => {
        worklet.port.onmessage = null;
        worklet.port.close();
      };
    } else {
      const scriptProcessor = this.context.createScriptProcessor(AUDIO_BUFFER_SIZE, 1, 1);
      scriptProcessor.onaudioprocess = (event) => acceptSamples(event.inputBuffer.getChannelData(0));
      processor = scriptProcessor;
      stopProcessor = () => {
        scriptProcessor.onaudioprocess = null;
      };
    }
    source.connect(processor);
    processor.connect(muted);
    muted.connect(this.context.destination);

    let stopped = false;
    const capture: VoiceMediaCapture = {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        stopProcessor();
        if (pendingPcmBytes > 0) emitPcm(pendingPcmBytes);
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
    this.workletInstalled = false;
    await this.speechDetector?.close().catch(() => undefined);
    this.speechDetector = undefined;
    this.speechPreparation = undefined;
    this.capabilities.captureActivity = false;
    this.capabilities.autonomousOrchestration = false;
  }

  private async prepareSpeechDetector(): Promise<void> {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return;
    let detector: BrowserSpeechPresenceDetector | undefined;
    try {
      const worker = new Worker(new URL('./sileroVadWorker.ts', import.meta.url), {
        type: 'module',
        name: 'doompi-silero-vad',
      });
      detector = new BrowserSpeechPresenceDetector(worker as unknown as SpeechWorker, () => {
        this.speechDetector = undefined;
        this.capabilities.captureActivity = false;
        this.capabilities.autonomousOrchestration = false;
      });
      await detector.initialize(new URL('../models/silero_vad_v6.2.1.onnx', import.meta.url).href);
      this.speechDetector = detector;
      this.capabilities.captureActivity = true;
      this.capabilities.autonomousOrchestration = true;
    } catch {
      await detector?.close().catch(() => undefined);
    }
  }
}
