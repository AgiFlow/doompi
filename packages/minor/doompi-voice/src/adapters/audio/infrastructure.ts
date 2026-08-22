import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedVoiceConfig, VoiceTtsConfig } from '@agimon-ai/doompi-config';
import { encodePcm16Wav, PcmFrameAssembler } from '../../services/pcm.ts';
import {
  type AudioAnalysis,
  type BinaryProcessStartOptions,
  type BinaryRunningProcess,
  type IAudioAnalyzer,
  type IAudioRecorder,
  type IBinaryProcessSpawner,
  type IClock,
  type IExecutableResolver,
  type IPcmAudioRecorder,
  type IProcessSpawner,
  type ITemporaryWorkspace,
  type ITtsAdapter,
  type LiveRecordingHandle,
  type ProcessResult,
  type ProcessStartOptions,
  type RecordingHandle,
  type RunningProcess,
  type TimerHandle,
  type TtsPlayback,
  type TtsPlaybackOutcome,
  type TtsPlaybackReference,
  type TtsPlaybackResult,
  type TtsSpeakRequest,
} from '../../types/index.ts';

const SAMPLE_RATE = '16000';
const STOP_GRACE_MS = 1_500;
const FFMPEG_BINARY = 'ffmpeg';
const RECORDING_FILE = 'recording.wav';
const MACOS_SAY_BINARY = '/usr/bin/say';
const MACOS_SAY_FALLBACK = 'say';
const MACOS_PLATFORM = 'darwin';
const MACOS_RECORDING_ONLY_ERROR = 'Voice recording is supported on macOS only';
const INTERRUPT_SIGNAL = 'SIGINT';
const TERMINATE_SIGNAL = 'SIGTERM';
const KILL_SIGNAL = 'SIGKILL';
const ASCII_ENCODING = 'ascii';
const FFMPEG_INPUT_OPTIONS = ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i'] as const;
const FFMPEG_PCM_OPTIONS = ['-ac', '1', '-ar', SAMPLE_RATE, '-c:a', 'pcm_s16le', '-y'] as const;
const FFMPEG_RAW_PCM_OPTIONS = ['-ac', '1', '-ar', SAMPLE_RATE, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'] as const;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_VALUE_LIMIT = 32_768;
const ANALYSIS_FRAME_MS = 20;
const DBFS_SCALE = 20;
const VOICED_DBFS_THRESHOLD = -50;
const MINIMUM_VOICED_MS = 200;
export class SystemClock implements IClock {
  now(): number {
    return Date.now();
  }
  setInterval(callback: () => void, milliseconds: number): TimerHandle {
    return setInterval(callback, milliseconds);
  }
  setTimeout(callback: () => void, milliseconds: number): TimerHandle {
    return setTimeout(callback, milliseconds);
  }
  clear(handle: TimerHandle): void {
    clearTimeout(handle);
  }
}
export class ExecutableResolver implements IExecutableResolver {
  resolve(configured: string | undefined, fallback: string): string {
    if (configured) {
      fs.accessSync(configured, fs.constants.X_OK);
      return configured;
    }
    let lastAccessError: unknown;
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(directory, fallback);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (error) {
        lastAccessError = error;
      }
    }
    throw new Error(`Required executable not found on PATH: ${fallback}`, { cause: lastAccessError });
  }
}
export class NodeProcessSpawner implements IProcessSpawner {
  start(executable: string, args: readonly string[], options: ProcessStartOptions = {}): RunningProcess {
    const child = spawn(executable, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const abort = (): void => {
      child.kill(KILL_SIGNAL);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const completion = new Promise<ProcessResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    }).finally(() => options.signal?.removeEventListener('abort', abort));
    return { completion, signal: (signal) => child.kill(signal) };
  }
  async run(executable: string, args: readonly string[], options: ProcessStartOptions = {}): Promise<ProcessResult> {
    return this.start(executable, args, options).completion;
  }
}
export class NodeBinaryProcessSpawner implements IBinaryProcessSpawner {
  start(executable: string, args: readonly string[], options: BinaryProcessStartOptions = {}): BinaryRunningProcess {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: [options.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdinError = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin?.on('error', (error: Error) => {
      stdinError = error.message;
    });
    const abort = (): void => {
      child.kill(KILL_SIGNAL);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const completion = new Promise<ProcessResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        resolve({
          code: code ?? 1,
          stdout: '',
          stderr: [stderr, stdinError].filter(Boolean).join('\n'),
        }),
      );
    }).finally(() => options.signal?.removeEventListener('abort', abort));
    return {
      completion,
      signal: (signal) => child.kill(signal),
      onStdout: (listener) => {
        child.stdout!.on('data', listener);
        return () => child.stdout!.off('data', listener);
      },
      writeStdin: (data) => child.stdin?.write(data) ?? false,
      closeStdin: () => child.stdin?.end(),
    };
  }
}
export class TemporaryWorkspace implements ITemporaryWorkspace {
  create(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-'));
    fs.chmodSync(directory, 0o700);
    return directory;
  }
  writeFile(directory: string, fileName: string, data: Buffer): string {
    const filePath = path.join(directory, fileName);
    fs.writeFileSync(filePath, data, { mode: 0o600 });
    return filePath;
  }
  remove(directory: string): void {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
class FfmpegRecording implements RecordingHandle {
  constructor(
    readonly filePath: string,
    private readonly process: RunningProcess,
    private readonly clock: IClock,
  ) {}
  async stop(): Promise<void> {
    this.process.signal(INTERRUPT_SIGNAL);
    let escalation: TimerHandle | undefined = this.clock.setTimeout(() => {
      this.process.signal(TERMINATE_SIGNAL);
      escalation = this.clock.setTimeout(() => {
        this.process.signal(KILL_SIGNAL);
      }, STOP_GRACE_MS);
    }, STOP_GRACE_MS);
    try {
      const result = await this.process.completion;
      if (result.code !== 0 && !fs.existsSync(this.filePath))
        throw new Error(result.stderr || `FFmpeg exited with code ${result.code}`);
    } finally {
      if (escalation) this.clock.clear(escalation);
    }
  }
  async abort(): Promise<void> {
    this.process.signal(KILL_SIGNAL);
    await this.process.completion.catch(() => undefined);
  }
}
export class FfmpegAudioRecorder implements IAudioRecorder {
  constructor(
    private readonly executables: IExecutableResolver,
    private readonly spawner: IProcessSpawner,
    private readonly clock: IClock,
  ) {}
  preflight(config: ResolvedVoiceConfig): void {
    if (process.platform !== MACOS_PLATFORM) throw new Error(MACOS_RECORDING_ONLY_ERROR);
    this.executables.resolve(config.recorder.binary, FFMPEG_BINARY);
  }
  start(config: ResolvedVoiceConfig, workspace: string): RecordingHandle {
    const executable = this.executables.resolve(config.recorder.binary, FFMPEG_BINARY);
    const filePath = path.join(workspace, RECORDING_FILE);
    const args = [...FFMPEG_INPUT_OPTIONS, config.recorder.device, ...FFMPEG_PCM_OPTIONS, filePath];
    return new FfmpegRecording(filePath, this.spawner.start(executable, args), this.clock);
  }
}
class FfmpegPcmRecording implements LiveRecordingHandle {
  readonly completion: Promise<ProcessResult>;
  private readonly assembler = new PcmFrameAssembler();
  private readonly disposeStdout: () => void;
  private accepting = true;
  private stopping?: Promise<Buffer>;

  constructor(
    private readonly process: BinaryRunningProcess,
    private readonly clock: IClock,
    onFrame: (frame: Buffer) => void,
  ) {
    this.disposeStdout = process.onStdout((chunk) => {
      if (!this.accepting) return;
      for (const frame of this.assembler.push(chunk)) onFrame(frame);
    });
    this.completion = process.completion.finally(() => {
      this.accepting = false;
      this.disposeStdout();
    });
  }

  stop(): Promise<Buffer> {
    this.stopping ??= this.stopProcess();
    return this.stopping;
  }

  async abort(): Promise<Buffer> {
    this.accepting = false;
    this.disposeStdout();
    this.process.signal(KILL_SIGNAL);
    await this.completion.catch(() => undefined);
    return this.assembler.flush();
  }

  private async stopProcess(): Promise<Buffer> {
    this.process.signal(INTERRUPT_SIGNAL);
    let terminateTimer: TimerHandle | undefined;
    let killTimer: TimerHandle | undefined;
    terminateTimer = this.clock.setTimeout(() => {
      this.process.signal(TERMINATE_SIGNAL);
      killTimer = this.clock.setTimeout(() => {
        this.process.signal(KILL_SIGNAL);
      }, STOP_GRACE_MS);
    }, STOP_GRACE_MS);
    try {
      await this.completion;
      return this.assembler.flush();
    } finally {
      if (terminateTimer) this.clock.clear(terminateTimer);
      if (killTimer) this.clock.clear(killTimer);
    }
  }
}
export class FfmpegPcmAudioRecorder implements IPcmAudioRecorder {
  constructor(
    private readonly executables: IExecutableResolver,
    private readonly spawner: IBinaryProcessSpawner,
    private readonly clock: IClock,
  ) {}
  preflight(config: ResolvedVoiceConfig): void {
    if (process.platform !== MACOS_PLATFORM) throw new Error(MACOS_RECORDING_ONLY_ERROR);
    this.executables.resolve(config.recorder.binary, FFMPEG_BINARY);
  }
  start(config: ResolvedVoiceConfig, onFrame: (frame: Buffer) => void): LiveRecordingHandle {
    const executable = this.executables.resolve(config.recorder.binary, FFMPEG_BINARY);
    const args = [...FFMPEG_INPUT_OPTIONS, config.recorder.device, ...FFMPEG_RAW_PCM_OPTIONS];
    return new FfmpegPcmRecording(this.spawner.start(executable, args), this.clock, onFrame);
  }
}
class MacOsSayPlayback implements TtsPlayback {
  readonly reference: TtsPlaybackReference;
  readonly completion: Promise<TtsPlaybackResult>;
  private requestedOutcome: TtsPlaybackOutcome | undefined;
  private stopping?: Promise<void>;
  private aborting?: Promise<void>;

  constructor(
    request: TtsSpeakRequest,
    private readonly process: BinaryRunningProcess,
    private readonly clock: IClock,
  ) {
    this.reference = {
      id: request.id,
      kind: request.kind,
      text: request.text,
      startedAt: clock.now(),
    };
    this.completion = process.completion.then((result) => ({
      outcome: this.requestedOutcome ?? (result.code === 0 ? 'completed' : 'failed'),
      reference: { ...this.reference, endedAt: this.clock.now() },
      process: result,
    }));
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopProcess();
    return this.stopping;
  }

  abort(): Promise<void> {
    this.aborting ??= this.abortProcess();
    return this.aborting;
  }

  private async abortProcess(): Promise<void> {
    this.requestedOutcome = 'aborted';
    this.process.signal(KILL_SIGNAL);
    await this.completion.then(() => undefined);
  }

  private async stopProcess(): Promise<void> {
    this.requestedOutcome ??= 'stopped';
    this.process.signal(INTERRUPT_SIGNAL);
    let terminateTimer: TimerHandle | undefined;
    let killTimer: TimerHandle | undefined;
    terminateTimer = this.clock.setTimeout(() => {
      this.process.signal(TERMINATE_SIGNAL);
      killTimer = this.clock.setTimeout(() => {
        this.process.signal(KILL_SIGNAL);
      }, STOP_GRACE_MS);
    }, STOP_GRACE_MS);
    try {
      await this.completion;
    } finally {
      if (terminateTimer) this.clock.clear(terminateTimer);
      if (killTimer) this.clock.clear(killTimer);
    }
  }
}

export class MacOsSayTtsAdapter implements ITtsAdapter {
  constructor(
    private readonly executables: IExecutableResolver,
    private readonly spawner: IBinaryProcessSpawner,
    private readonly clock: IClock,
  ) {}

  preflight(_config: VoiceTtsConfig): void {
    if (process.platform !== MACOS_PLATFORM) throw new Error('Voice narration is supported on macOS only');
    this.executables.resolve(MACOS_SAY_BINARY, MACOS_SAY_FALLBACK);
  }

  speak(request: TtsSpeakRequest): TtsPlayback {
    const text = request.text.trim();
    if (!text) throw new Error('Voice narration text must not be empty');
    const args: string[] = [];
    if (request.config.voice) args.push('-v', request.config.voice);
    if (request.config.rate !== undefined) args.push('-r', String(request.config.rate));
    const executable = this.executables.resolve(MACOS_SAY_BINARY, MACOS_SAY_FALLBACK);
    const processHandle = this.spawner.start(executable, args, { stdin: 'pipe' });
    processHandle.writeStdin(text);
    processHandle.closeStdin();
    return new MacOsSayPlayback({ ...request, text }, processHandle, this.clock);
  }
}

export function writePrivatePcm16Wav(filePath: string, pcm: Buffer): void {
  fs.writeFileSync(filePath, encodePcm16Wav(pcm), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}
export function analyzePcmWav(buffer: Buffer): AudioAnalysis {
  if (
    buffer.length < 12 ||
    buffer.toString(ASCII_ENCODING, 0, 4) !== 'RIFF' ||
    buffer.toString(ASCII_ENCODING, 8, 12) !== 'WAVE'
  )
    throw new Error('Recording is not a PCM WAV file');
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audio: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString(ASCII_ENCODING, offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      if (buffer.readUInt16LE(start) !== 1) throw new Error('Recording must use PCM encoding');
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === 'data') audio = buffer.subarray(start, Math.min(start + size, buffer.length));
    offset = start + size + (size % 2);
  }
  if (channels !== PCM_CHANNELS || bitsPerSample !== PCM_BITS_PER_SAMPLE || sampleRate <= 0)
    throw new Error('Recording must be 16-bit mono PCM');
  const frameSamples = Math.floor((sampleRate * ANALYSIS_FRAME_MS) / 1_000);
  let voicedFrames = 0;
  for (let sample = 0; sample + frameSamples <= audio.length / 2; sample += frameSamples) {
    let squareSum = 0;
    for (let index = 0; index < frameSamples; index += 1) {
      const value = audio.readInt16LE((sample + index) * 2) / PCM_VALUE_LIMIT;
      squareSum += value * value;
    }
    const rms = Math.sqrt(squareSum / frameSamples);
    const dbfs = rms === 0 ? Number.NEGATIVE_INFINITY : DBFS_SCALE * Math.log10(rms);
    if (dbfs > VOICED_DBFS_THRESHOLD) voicedFrames += 1;
  }
  const voicedMilliseconds = voicedFrames * ANALYSIS_FRAME_MS;
  return { silent: audio.length === 0 || voicedMilliseconds < MINIMUM_VOICED_MS, voicedMilliseconds };
}
export class PcmWavAnalyzer implements IAudioAnalyzer {
  analyze(filePath: string): AudioAnalysis {
    return analyzePcmWav(fs.readFileSync(filePath));
  }
}
