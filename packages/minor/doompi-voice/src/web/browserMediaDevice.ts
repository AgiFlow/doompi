import sileroVadModelUrl from './models/silero_vad_v6.2.1.onnx?url';
import type { SpeechPresenceDetector } from '../types/clientCaptureActivity.ts';
import type {
  VoiceMediaCapabilities,
  VoiceMediaCapture,
  VoiceMediaCaptureSpeechAnalysis,
  VoiceMediaDevice,
  VoiceMediaPlayback,
  VoiceMediaPlaybackOutcome,
  VoiceMediaPlaybackResult,
} from '../types/clientMedia.ts';
import { VOICE_MEDIA_SAMPLE_RATE } from '../types/clientMedia.ts';
import browserCaptureWorkletUrl from './browserCaptureWorklet.js?url';
import { BrowserNarrationEchoDiscriminator } from './browserNarrationEchoDiscriminator.ts';
import { BrowserSpeechPresenceDetector, type SpeechWorker } from './browserSpeechPresenceDetector.ts';
import sileroVadWorkerUrl from './sileroVadWorker.ts?worker&url';

const AUDIO_BUFFER_SIZE = 4_096;
const AUDIO_UPLOAD_DURATION_MS = 100;
const AUDIO_WORKLET_NAME = 'doompi-voice-capture';
const DEFAULT_SPEECH_RATE_WPM = 180;
const SPEECH_START_TIMEOUT_MS = 5_000;
const SPEECH_WARMUP_TIMEOUT_MS = 10_000;
const MIN_SPEECH_RATE = 0.1;
const MAX_SPEECH_RATE = 10;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_MAXIMUM = 32_767;
const PCM_MINIMUM = -32_768;
const PCM_UPLOAD_BYTES = (VOICE_MEDIA_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * AUDIO_UPLOAD_DURATION_MS) / 1_000;
const SILENT_OUTPUT_GAIN = 1e-8;
const CAPTURE_CLOCK_DISCONTINUITY_SECONDS = 0.05;
const ECHO_REACQUISITION_SAMPLES = (VOICE_MEDIA_SAMPLE_RATE * 300) / 1_000;

type SpeechUtteranceConstructor = new (text?: string) => SpeechSynthesisUtterance;

interface CaptureWorkletMessage {
  samples: Float32Array;
  capturedAt: number;
}

function isCaptureWorkletMessage(value: unknown): value is CaptureWorkletMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { samples?: unknown; capturedAt?: unknown };
  return candidate.samples instanceof Float32Array && typeof candidate.capturedAt === 'number';
}

function browserSpeechPlaybackAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis?.speak === 'function';
}

function browserPcmPlaybackAvailable(): boolean {
  return typeof AudioContext === 'function';
}

function speechUtteranceConstructor(): SpeechUtteranceConstructor | undefined {
  if (typeof SpeechSynthesisUtterance === 'function') return SpeechSynthesisUtterance;
  if (typeof window === 'undefined') return undefined;
  const candidate = (window as Window & { SpeechSynthesisUtterance?: SpeechUtteranceConstructor })
    .SpeechSynthesisUtterance;
  return typeof candidate === 'function' ? candidate : undefined;
}
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
  private startTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly synthesis: SpeechSynthesis,
    private readonly utterance: SpeechSynthesisUtterance,
    private readonly playbackId: string,
  ) {
    this.completion = new Promise((resolve) => {
      this.settleCompletion = resolve;
    });
    utterance.onstart = () => {
      if (this.startTimer !== undefined) clearTimeout(this.startTimer);
      this.startTimer = undefined;
    };
    utterance.onend = () => this.settle(this.requestedOutcome ?? 'completed');
    utterance.onerror = (event) =>
      this.settle(this.requestedOutcome ?? 'failed', event.error || 'Browser speech synthesis failed.');
    this.startTimer = setTimeout(() => {
      this.synthesis.cancel();
      this.settle('failed', 'Browser speech synthesis did not start.');
    }, SPEECH_START_TIMEOUT_MS);
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
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    this.fadeTimer = undefined;
    this.restoreTimer = undefined;
    this.startTimer = undefined;
    this.utterance.onstart = null;
    this.utterance.onend = null;
    this.utterance.onerror = null;
    this.settleCompletion({ playbackId: this.playbackId, outcome, ...(error ? { error } : {}) });
  }
}

class BrowserPcmPlayback implements VoiceMediaPlayback {
  public readonly completion: Promise<VoiceMediaPlaybackResult>;
  private source: AudioBufferSourceNode | undefined;
  private gain: GainNode | undefined;
  private settled = false;
  private settleCompletion!: (result: VoiceMediaPlaybackResult) => void;
  private restoreTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAt: number | undefined;

  public constructor(
    private readonly context: AudioContext,
    audio: Promise<Uint8Array>,
    private readonly playbackId: string,
    private readonly echoDiscriminator: BrowserNarrationEchoDiscriminator,
  ) {
    this.completion = new Promise((resolve) => {
      this.settleCompletion = resolve;
    });
    void this.start(audio);
  }

  public stop(outcome: Extract<VoiceMediaPlaybackOutcome, 'stopped' | 'aborted'>): void {
    if (this.settled) return;
    if (this.source !== undefined) this.source.onended = null;
    this.source?.stop();
    this.settle(outcome);
  }

  public duck(targetGain: number, _fadeMs: number, holdMs: number): void {
    if (this.settled || this.gain === undefined) return;
    this.gain.gain.value = Math.max(0, Math.min(1, targetGain));
    if (this.restoreTimer !== undefined) clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(
      () => {
        this.restoreTimer = undefined;
        if (this.gain !== undefined) this.gain.gain.value = 1;
      },
      Math.max(0, holdMs),
    );
  }

  private async start(audio: Promise<Uint8Array>): Promise<void> {
    try {
      const pcm = await audio;
      if (this.settled) return;
      if (pcm.byteLength === 0 || pcm.byteLength % PCM_BYTES_PER_SAMPLE !== 0)
        throw new Error('Streamed narration audio is empty or incomplete.');
      if (this.context.state !== 'running')
        throw new Error('Browser audio playback is suspended. Tap the voice control.');
      const samples = new Float32Array(pcm.byteLength / PCM_BYTES_PER_SAMPLE);
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32_768;
      const buffer = this.context.createBuffer(1, samples.length, VOICE_MEDIA_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      gain.gain.value = 1;
      source.buffer = buffer;
      source.onended = () => this.settle('completed');
      source.connect(gain);
      gain.connect(this.context.destination);
      this.source = source;
      this.gain = gain;
      const startedAt = this.context.currentTime;
      this.startedAt = startedAt;
      this.echoDiscriminator.beginPlayback(this.playbackId, buffer.getChannelData(0), startedAt);
      source.start(startedAt);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.settle('failed', message);
    }
  }

  private settle(outcome: VoiceMediaPlaybackOutcome, error?: string): void {
    if (this.settled) return;
    this.settled = true;
    if (this.restoreTimer !== undefined) clearTimeout(this.restoreTimer);
    if (this.source !== undefined) this.source.onended = null;
    if (this.startedAt !== undefined) this.echoDiscriminator.endPlayback(this.playbackId, this.context.currentTime);
    this.source?.disconnect();
    this.gain?.disconnect();
    this.source = undefined;
    this.gain = undefined;
    this.settleCompletion({ playbackId: this.playbackId, outcome, ...(error ? { error } : {}) });
  }
}
export class BrowserVoiceMediaDevice implements VoiceMediaDevice {
  public readonly capabilities: VoiceMediaCapabilities = {
    capture: typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined,
    playback: browserSpeechPlaybackAvailable() || browserPcmPlaybackAvailable(),
    captureActivity: false,
    autonomousOrchestration: false,
    playbackDucking: browserSpeechPlaybackAvailable() || browserPcmPlaybackAvailable(),
  };
  public constructor(private readonly rebindProtocolSupported = false) {}

  /** Arms browser media while a real tap is still carrying mobile user activation. */
  public armUserGesture(): void {
    this.listenForMediaUnlock();
  }
  private stream: MediaStream | undefined;
  private context: AudioContext | undefined;
  private workletInstalled = false;
  private activeCapture: VoiceMediaCapture | undefined;
  private activePlayback: VoiceMediaPlayback | undefined;
  private speechDetector: BrowserSpeechPresenceDetector | undefined;
  private preparingSpeechDetector: BrowserSpeechPresenceDetector | undefined;
  private speechPreparation: Promise<void> | undefined;
  private listeningForMediaUnlock = false;
  private speechWarmup: SpeechSynthesisUtterance | undefined;
  private speechWarmupTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly echoDiscriminator = new BrowserNarrationEchoDiscriminator();

  private readonly unlockMedia = (): void => {
    if (typeof AudioContext !== 'undefined') {
      try {
        this.context ??= new AudioContext();
        const context = this.context;
        void context
          .resume()
          .then(() => {
            if (context.state === 'running') this.stopListeningForMediaUnlock();
          })
          .catch(() => undefined);
      } catch {
        // Capture reports unsupported audio contexts when the host requests it.
      }
    }
    this.warmSpeechSynthesis();
  };
  public async prepare(): Promise<void> {
    this.armUserGesture();
    this.speechPreparation ??= this.prepareSpeechDetector();
    await this.speechPreparation;
  }

  public createSpeechPresenceDetector(): SpeechPresenceDetector | undefined {
    return this.speechDetector;
  }

  public async startCapture(
    onPcm: (pcm: Uint8Array, speechAnalysis?: VoiceMediaCaptureSpeechAnalysis) => void,
  ): Promise<VoiceMediaCapture> {
    if (!this.capabilities.capture) throw new Error('This browser cannot capture microphone audio.');
    if (this.activeCapture !== undefined) throw new Error('Browser microphone capture is already active.');
    this.stream ??= await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.context ??= new AudioContext();
    await this.context.resume();
    if (this.context.state !== 'running')
      throw new Error('Browser audio capture is suspended. Tap the voice control and try again.');
    this.stopListeningForMediaUnlock();

    const captureStream = this.stream;
    const source = this.context.createMediaStreamSource(captureStream);
    const muted = this.context.createGain();
    muted.gain.value = SILENT_OUTPUT_GAIN;
    const resampler = new Pcm16Resampler(this.context.sampleRate);
    this.echoDiscriminator.resetCapture();
    let pendingPcmChunks: Uint8Array[] = [];
    let pendingPcmBytes = 0;
    let captureStartedAt: number | undefined;
    let emittedPcmSamples = 0;
    let expectedCaptureAt: number | undefined;
    let echoTrustBlockedSamples = 0;
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
      const sampleCount = byteLength / PCM_BYTES_PER_SAMPLE;
      const endedAt =
        (captureStartedAt ?? this.context!.currentTime) + (emittedPcmSamples + sampleCount) / VOICE_MEDIA_SAMPLE_RATE;
      emittedPcmSamples += sampleCount;
      const discrimination = this.echoDiscriminator.process(upload, endedAt);
      const trustBlocked = echoTrustBlockedSamples > 0;
      echoTrustBlockedSamples = Math.max(0, echoTrustBlockedSamples - sampleCount);
      onPcm(upload, {
        speechPcm: trustBlocked ? new Uint8Array(upload.byteLength) : discrimination.speechPcm,
        echoReferenceActive: discrimination.referenceActive,
        echoDiscriminated: !trustBlocked && discrimination.speechDiscriminated,
      });
    };
    const acceptSamples = (samples: Float32Array, capturedAt?: number): void => {
      const timestamp = capturedAt !== undefined && Number.isFinite(capturedAt) ? capturedAt : undefined;
      if (
        timestamp !== undefined &&
        expectedCaptureAt !== undefined &&
        Math.abs(timestamp - expectedCaptureAt) > CAPTURE_CLOCK_DISCONTINUITY_SECONDS
      ) {
        this.echoDiscriminator.resetCapture();
        echoTrustBlockedSamples = pendingPcmBytes / PCM_BYTES_PER_SAMPLE + ECHO_REACQUISITION_SAMPLES;
        captureStartedAt =
          timestamp - (emittedPcmSamples + pendingPcmBytes / PCM_BYTES_PER_SAMPLE) / VOICE_MEDIA_SAMPLE_RATE;
      }
      if (timestamp !== undefined) expectedCaptureAt = timestamp + samples.length / this.context!.sampleRate;
      captureStartedAt ??= timestamp ?? this.context!.currentTime - samples.length / this.context!.sampleRate;
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
        await this.context.audioWorklet.addModule(browserCaptureWorkletUrl);
        this.workletInstalled = true;
      }
      const worklet = new AudioWorkletNode(this.context, AUDIO_WORKLET_NAME);
      worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        if (isCaptureWorkletMessage(event.data)) acceptSamples(event.data.samples, event.data.capturedAt);
      };
      processor = worklet;
      stopProcessor = () => {
        worklet.port.onmessage = null;
        worklet.port.close();
      };
    } else {
      const scriptProcessor = this.context.createScriptProcessor(AUDIO_BUFFER_SIZE, 1, 1);
      scriptProcessor.onaudioprocess = (event) =>
        acceptSamples(event.inputBuffer.getChannelData(0), event.playbackTime);
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
        if (!this.rebindProtocolSupported || this.stream !== captureStream)
          for (const track of captureStream.getTracks()) track.stop();
        if (!this.rebindProtocolSupported && this.stream === captureStream) this.stream = undefined;
        if (this.activeCapture === capture) this.activeCapture = undefined;
      },
    };
    this.activeCapture = capture;
    return capture;
  }

  public speak(request: Parameters<VoiceMediaDevice['speak']>[0], audio?: Promise<Uint8Array>): VoiceMediaPlayback {
    if (!this.capabilities.playback) throw new Error('This browser cannot play speech narration.');
    this.activePlayback?.stop('aborted');
    let playback: VoiceMediaPlayback;
    if (request.delivery === 'streamed') {
      if (audio === undefined) throw new Error('Streamed narration audio is unavailable.');
      if (typeof AudioContext !== 'function') throw new Error('This browser cannot play streamed narration audio.');
      if (this.context === undefined || this.context.state !== 'running')
        throw new Error('Browser audio playback is not unlocked. Tap the voice control and try again.');
      playback = new BrowserPcmPlayback(this.context, audio, request.playbackId, this.echoDiscriminator);
    } else {
      this.finishSpeechWarmup(false);
      const synthesis = window.speechSynthesis;
      const Utterance = speechUtteranceConstructor();
      if (Utterance === undefined) throw new Error('This browser does not expose speech utterance playback.');
      synthesis.resume();
      const utterance = new Utterance(request.text);
      if (request.rate !== undefined) {
        utterance.rate = Math.max(MIN_SPEECH_RATE, Math.min(MAX_SPEECH_RATE, request.rate / DEFAULT_SPEECH_RATE_WPM));
      }
      if (request.voice) {
        utterance.voice =
          synthesis.getVoices().find((voice) => voice.name === request.voice || voice.voiceURI === request.voice) ??
          null;
      }
      playback = new BrowserSpeechPlayback(synthesis, utterance, request.playbackId);
      synthesis.speak(utterance);
    }
    this.activePlayback = playback;
    void playback.completion.finally(() => {
      if (this.activePlayback === playback) this.activePlayback = undefined;
    });
    return playback;
  }

  public async close(): Promise<void> {
    const speechDetector = this.speechDetector;
    const preparingSpeechDetector = this.preparingSpeechDetector;
    const speechPreparation = this.speechPreparation;
    this.speechDetector = undefined;
    this.preparingSpeechDetector = undefined;
    this.speechPreparation = undefined;
    this.capabilities.captureActivity = false;
    this.capabilities.autonomousOrchestration = false;

    await speechDetector?.close().catch(() => undefined);
    if (preparingSpeechDetector !== speechDetector) await preparingSpeechDetector?.close().catch(() => undefined);
    await speechPreparation?.catch(() => undefined);
    this.stopListeningForMediaUnlock();
    this.finishSpeechWarmup(true);
    await this.activeCapture?.stop();
    this.activePlayback?.stop('aborted');
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    if (this.context !== undefined && this.context.state !== 'closed') await this.context.close();
    this.echoDiscriminator.reset();
    this.context = undefined;
    this.workletInstalled = false;
  }

  private listenForMediaUnlock(): void {
    if (
      this.listeningForMediaUnlock ||
      typeof window === 'undefined' ||
      (!this.capabilities.capture && !this.capabilities.playback)
    )
      return;
    this.listeningForMediaUnlock = true;
    window.addEventListener('pointerdown', this.unlockMedia, { capture: true, passive: true });
    window.addEventListener('keydown', this.unlockMedia, { capture: true });
  }

  private stopListeningForMediaUnlock(): void {
    if (!this.listeningForMediaUnlock || typeof window === 'undefined') return;
    this.listeningForMediaUnlock = false;
    window.removeEventListener('pointerdown', this.unlockMedia, true);
    window.removeEventListener('keydown', this.unlockMedia, true);
  }

  private warmSpeechSynthesis(): void {
    if (!browserSpeechPlaybackAvailable() || this.activePlayback !== undefined || this.speechWarmup !== undefined)
      return;
    const synthesis = window.speechSynthesis;
    const Utterance = speechUtteranceConstructor();
    if (Utterance === undefined) return;
    synthesis.resume();
    if (synthesis.speaking || synthesis.pending) return;
    const utterance = new Utterance('a');
    utterance.volume = 0.01;
    utterance.rate = MAX_SPEECH_RATE;
    utterance.onend = () => this.finishSpeechWarmup(false);
    utterance.onerror = () => this.finishSpeechWarmup(false);
    this.speechWarmup = utterance;
    this.speechWarmupTimer = setTimeout(() => this.finishSpeechWarmup(true), SPEECH_WARMUP_TIMEOUT_MS);
    synthesis.speak(utterance);
  }

  private finishSpeechWarmup(cancel: boolean): void {
    const utterance = this.speechWarmup;
    if (utterance === undefined) return;
    if (this.speechWarmupTimer !== undefined) clearTimeout(this.speechWarmupTimer);
    this.speechWarmupTimer = undefined;
    this.speechWarmup = undefined;
    utterance.onend = null;
    utterance.onerror = null;
    if (cancel) window.speechSynthesis.cancel();
  }

  private async prepareSpeechDetector(): Promise<void> {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return;
    let detector: BrowserSpeechPresenceDetector | undefined;
    try {
      detector = new BrowserSpeechPresenceDetector(
        new Worker(sileroVadWorkerUrl, {
          type: 'module',
          name: 'doompi-silero-vad',
        }) as unknown as SpeechWorker,
        () => {
          if (this.preparingSpeechDetector !== detector && this.speechDetector !== detector) return;
          if (this.preparingSpeechDetector === detector) this.preparingSpeechDetector = undefined;
          if (this.speechDetector === detector) this.speechDetector = undefined;
          this.capabilities.captureActivity = false;
          this.capabilities.autonomousOrchestration = false;
        },
      );
      this.preparingSpeechDetector = detector;
      await detector.initialize(sileroVadModelUrl);
      if (this.preparingSpeechDetector !== detector) {
        await detector.close().catch(() => undefined);
        return;
      }
      this.preparingSpeechDetector = undefined;
      this.speechDetector = detector;
      this.capabilities.captureActivity = true;
      this.capabilities.autonomousOrchestration = this.rebindProtocolSupported;
    } catch {
      if (this.preparingSpeechDetector === detector) this.preparingSpeechDetector = undefined;
      if (this.speechDetector === detector) this.speechDetector = undefined;
      await detector?.close().catch(() => undefined);
    }
  }
}
