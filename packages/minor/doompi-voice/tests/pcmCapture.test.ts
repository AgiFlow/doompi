import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FfmpegPcmAudioRecorder,
  NodeBinaryProcessSpawner,
  NodeProcessSpawner,
  PCM_FRAME_BYTES,
  PcmFrameAssembler,
  encodePcm16Wav,
  writePrivatePcm16Wav,
  type BinaryRunningProcess,
  type IClock,
  type ProcessResult,
  type TimerHandle,
} from '../src/exports';

const temporaryDirectories: string[] = [];
const resolvedConfig: ResolvedVoiceConfig = {
  engine: 'whisper-cpp',
  language: 'auto',
  recorder: { device: 'none:default' },
  adapters: { 'whisper-cpp': { model: { path: '/model.bin' } } },
};

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-pcm-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class DeferredBinaryProcess implements BinaryRunningProcess {
  readonly signals: NodeJS.Signals[] = [];
  readonly completion: Promise<ProcessResult>;
  private readonly listeners = new Set<(chunk: Buffer) => void>();
  private resolveCompletion!: (result: ProcessResult) => void;

  constructor() {
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  onStdout(listener: (chunk: Buffer) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  writeStdin(): boolean {
    return false;
  }

  closeStdin(): void {}

  signal(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  emit(chunk: Buffer): void {
    for (const listener of this.listeners) listener(chunk);
  }

  finish(result: ProcessResult = { code: 0, stdout: '', stderr: '' }): void {
    this.resolveCompletion(result);
  }
}

function controlledClock(): { clock: IClock; callbacks: (() => void)[] } {
  const callbacks: (() => void)[] = [];
  return {
    callbacks,
    clock: {
      now: () => 0,
      setInterval: () => ({}) as TimerHandle,
      setTimeout: (callback) => {
        callbacks.push(callback);
        return { index: callbacks.length - 1 } as unknown as TimerHandle;
      },
      clear: vi.fn(),
    },
  };
}

describe('PCM framing and WAV encoding', () => {
  it('preserves binary bytes across arbitrary chunks and flushes the final remainder', () => {
    const assembler = new PcmFrameAssembler();
    const input = Buffer.alloc(PCM_FRAME_BYTES * 2 + 17);
    for (let index = 0; index < input.length; index += 1) input[index] = index % 256;

    expect(assembler.push(input.subarray(0, 101))).toEqual([]);
    const first = assembler.push(input.subarray(101, PCM_FRAME_BYTES + 7));
    const second = assembler.push(input.subarray(PCM_FRAME_BYTES + 7));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(Buffer.concat([...first, ...second, assembler.flush()])).toEqual(input);
    expect(assembler.flush()).toEqual(Buffer.alloc(0));
  });

  it('encodes mono 16 kHz signed 16-bit PCM and writes it with private permissions', () => {
    const pcm = Buffer.alloc(320);
    pcm.writeInt16LE(12_345, 0);
    const wav = encodePcm16Wav(pcm);

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);

    const filePath = path.join(temporaryDirectory(), 'probe.wav');
    writePrivatePcm16Wav(filePath, pcm);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(filePath)).toEqual(wav);
  });

  it('rejects partial signed 16-bit samples', () => {
    expect(() => encodePcm16Wav(Buffer.alloc(3))).toThrow('complete 16-bit samples');
  });
});

describe('binary process and live FFmpeg capture', () => {
  it('keeps stdout as Buffer data and supports listener disposal', async () => {
    const running = new NodeBinaryProcessSpawner().start(process.execPath, [
      '-e',
      'process.stdout.write(Buffer.from([0, 255, 1, 128]))',
    ]);
    const chunks: Buffer[] = [];
    const dispose = running.onStdout((chunk) => chunks.push(chunk));

    const result = await running.completion;
    dispose();

    expect(result.code).toBe(0);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 1, 128]));
  });

  it('aborts text processes through an AbortSignal', async () => {
    const abortController = new AbortController();
    const running = new NodeProcessSpawner().start(process.execPath, ['-e', 'setInterval(() => undefined, 10_000)'], {
      signal: abortController.signal,
    });

    abortController.abort();
    const result = await running.completion;

    expect(result.code).not.toBe(0);
  });

  it('streams exact frames, returns a final partial frame, and uses raw FFmpeg output', async () => {
    const processHandle = new DeferredBinaryProcess();
    const started: { executable?: string; args?: readonly string[] } = {};
    const { clock } = controlledClock();
    const recorder = new FfmpegPcmAudioRecorder(
      { resolve: () => '/bin/ffmpeg' },
      {
        start: (executable, args) => {
          started.executable = executable;
          started.args = args;
          return processHandle;
        },
      },
      clock,
    );
    const frames: Buffer[] = [];

    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      recorder.preflight(resolvedConfig);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    const recording = recorder.start(resolvedConfig, (frame) => frames.push(frame));
    const input = Buffer.alloc(PCM_FRAME_BYTES + 23, 0x9a);
    processHandle.emit(input.subarray(0, 111));
    processHandle.emit(input.subarray(111));
    const stopping = recording.stop();
    processHandle.finish();

    expect(await stopping).toEqual(Buffer.alloc(23, 0x9a));
    expect(frames).toEqual([Buffer.alloc(PCM_FRAME_BYTES, 0x9a)]);
    expect(started).toEqual({
      executable: '/bin/ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'avfoundation',
        '-i',
        'none:default',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-f',
        's16le',
        'pipe:1',
      ],
    });
    expect(processHandle.signals).toEqual(['SIGINT']);
  });

  it('escalates live capture stop and abort deterministically without late frames', async () => {
    const processHandle = new DeferredBinaryProcess();
    const { callbacks, clock } = controlledClock();
    const recorder = new FfmpegPcmAudioRecorder(
      { resolve: () => '/bin/ffmpeg' },
      { start: () => processHandle },
      clock,
    );
    const frames: Buffer[] = [];
    const recording = recorder.start(resolvedConfig, (frame) => frames.push(frame));

    const stopping = recording.stop();
    callbacks[0]?.();
    callbacks[1]?.();
    processHandle.finish();
    await stopping;
    processHandle.emit(Buffer.alloc(PCM_FRAME_BYTES, 1));

    expect(processHandle.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(frames).toEqual([]);

    const abortProcess = new DeferredBinaryProcess();
    const abortRecording = new FfmpegPcmAudioRecorder(
      { resolve: () => '/bin/ffmpeg' },
      { start: () => abortProcess },
      clock,
    ).start(resolvedConfig, vi.fn());
    abortProcess.emit(Buffer.alloc(18, 7));
    const aborting = abortRecording.abort();
    abortProcess.finish({ code: 1, stdout: '', stderr: 'killed' });
    await expect(aborting).resolves.toEqual(Buffer.alloc(18, 7));
    expect(abortProcess.signals).toEqual(['SIGKILL']);
  });
});
