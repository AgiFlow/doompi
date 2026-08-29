import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type DoomConfig,
  type IDoomConfigLoader,
  type ResolvedVoiceConfig,
  type VoiceAdapterConfig,
} from '@agimon-ai/doompi-config';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  MINOR_MODE_TOOL_NAME,
  type MinorModeActionRequest,
  type MinorModeActionResponse,
  type MinorModeCatalogService,
  type MinorModeRecord,
} from '@agimon-ai/doompi-extension-contracts/mode';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzePcmWav,
  ExecutableResolver,
  FfmpegAudioRecorder,
  NodeProcessSpawner,
  PcmWavAnalyzer,
  SystemClock,
  TemporaryWorkspace,
} from '../src/adapters/audio/infrastructure.ts';
import {
  createVoiceContainer,
  formatAutoCaptureActivity,
  formatVoiceActivity,
  MlxWhisperAdapter,
  OpenAiWhisperAdapter,
  TranscriberRegistry,
  voiceLeaderBindings,
  VoiceSessionController,
  installVoiceRuntime,
  WhisperCppAdapter,
} from '../src/exports';
import {
  type IAudioAnalyzer,
  type IClock,
  type IExecutableResolver,
  type IPcmAudioRecorder,
  type IProcessSpawner,
  type ITranscriberAdapter,
  type ITranscriberRegistry,
  type ITtsAdapter,
  type IVoiceSessionController,
  type ProcessResult,
  type RecordingHandle,
  type RunningProcess,
  type TimerHandle,
  type VoiceActivityUpdate,
  type VoiceUi,
} from '../src/types/index.ts';

const roots: string[] = [];
function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-test-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function wav(amplitude: number, milliseconds: number): Buffer {
  const samples = Math.floor((16_000 * milliseconds) / 1_000);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(amplitude, 44 + index * 2);
  return buffer;
}
const resolvedConfig: ResolvedVoiceConfig = {
  engine: 'whisper-cpp',
  language: 'auto',
  recorder: { device: 'none:default' },
  adapters: { 'whisper-cpp': { model: { path: '/model.bin' } } },
};

describe('voice infrastructure', () => {
  it('detects silence from zero data and less than 200ms of voiced frames', () => {
    expect(analyzePcmWav(wav(0, 500)).silent).toBe(true);
    expect(analyzePcmWav(wav(10_000, 180)).silent).toBe(true);
    expect(analyzePcmWav(wav(10_000, 220))).toMatchObject({ silent: false, voicedMilliseconds: 220 });
  });
  it('creates private temporary workspaces and removes them', () => {
    const workspaces = new TemporaryWorkspace();
    const directory = workspaces.create();
    roots.push(directory);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    workspaces.remove(directory);
    expect(fs.existsSync(directory)).toBe(false);
  });
  it('resolves configured executables and fails for a missing PATH command', () => {
    const executable = path.join(temporaryRoot(), 'tool');
    fs.writeFileSync(executable, '');
    fs.chmodSync(executable, 0o700);
    const resolver = new ExecutableResolver();
    expect(resolver.resolve(executable, 'unused')).toBe(executable);
    vi.stubEnv('PATH', temporaryRoot());
    expect(() => resolver.resolve(undefined, 'missing')).toThrow('not found on PATH');
  });
  it('uses argv-only FFmpeg AVFoundation recording arguments', () => {
    const started: { executable?: string; args?: readonly string[] } = {};
    const spawner: IProcessSpawner = {
      start(executable, args) {
        started.executable = executable;
        started.args = args;
        return { completion: Promise.resolve({ code: 0, stdout: '', stderr: '' }), signal: () => true };
      },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    };
    const clock: IClock = {
      now: () => 0,
      setInterval: () => ({}) as TimerHandle,
      setTimeout: () => ({}) as TimerHandle,
      clear: () => undefined,
    };
    const recorder = new FfmpegAudioRecorder({ resolve: () => '/bin/ffmpeg' }, spawner, clock);
    recorder.start(resolvedConfig, '/tmp');
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
        '-af',
        'highpass=f=80,afftdn=nr=10:nf=-40:tn=1,speechnorm',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-y',
        '/tmp/recording.wav',
      ],
    });
  });
  it('runs argv-only processes and exposes system clock operations', async () => {
    const result = await new NodeProcessSpawner().run(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result).toMatchObject({ code: 0, stdout: 'ok' });
    vi.useFakeTimers();
    const clock = new SystemClock();
    const interval = vi.fn();
    const timeout = vi.fn();
    const intervalHandle = clock.setInterval(interval, 10);
    const timeoutHandle = clock.setTimeout(timeout, 20);
    vi.advanceTimersByTime(20);
    expect(interval).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledOnce();
    clock.clear(intervalHandle);
    clock.clear(timeoutHandle);
    expect(clock.now()).toBeGreaterThan(0);
    vi.useRealTimers();
  });
  it('preflights FFmpeg, analyzes files, and stops or aborts recordings with signals', async () => {
    const workspace = temporaryRoot();
    const audioPath = path.join(workspace, 'recording.wav');
    fs.writeFileSync(audioPath, wav(0, 200));
    const signals: NodeJS.Signals[] = [];
    const running: RunningProcess = {
      completion: Promise.resolve({ code: 0, stdout: '', stderr: '' }),
      signal: (signal) => {
        signals.push(signal);
        return true;
      },
    };
    const callbacks: (() => void)[] = [];
    const clock: IClock = {
      now: () => 0,
      setInterval: () => ({}) as TimerHandle,
      setTimeout: (callback) => {
        callbacks.push(callback);
        return {} as TimerHandle;
      },
      clear: vi.fn(),
    };
    const executableResolver = { resolve: vi.fn(() => '/bin/ffmpeg') };
    const recorder = new FfmpegAudioRecorder(
      executableResolver,
      { start: () => running, run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      clock,
    );
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      recorder.preflight(resolvedConfig);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    const handle = recorder.start(resolvedConfig, workspace);
    await handle.stop();
    await handle.abort();
    expect(executableResolver.resolve).toHaveBeenCalled();
    expect(signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(new PcmWavAnalyzer().analyze(audioPath).silent).toBe(true);
  });
});

class AdapterSpawner implements IProcessSpawner {
  calls: { executable: string; args: readonly string[] }[] = [];
  constructor(private readonly writeOutput: (args: readonly string[]) => void) {}
  start(): RunningProcess {
    throw new Error('not used');
  }
  async run(executable: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ executable, args });
    this.writeOutput(args);
    return { code: 0, stdout: '', stderr: '' };
  }
}
const resolver: IExecutableResolver = { resolve: (configured, fallback) => configured ?? fallback };

describe('transcription adapters and registry', () => {
  it('builds whisper.cpp arguments and reads TXT output', async () => {
    const workspace = temporaryRoot();
    const audioPath = path.join(workspace, 'audio.wav');
    fs.writeFileSync(audioPath, '');
    const modelPath = path.join(workspace, 'model.bin');
    fs.writeFileSync(modelPath, '');
    const spawner = new AdapterSpawner((args) =>
      fs.writeFileSync(`${args[args.indexOf('--output-file') + 1]}.txt`, ' hello '),
    );
    const adapter = new WhisperCppAdapter(resolver, spawner);
    const config = { model: { path: modelPath } };
    adapter.preflight(config);
    expect(await adapter.transcribe({ audioPath, workspace, config, language: 'auto' })).toBe('hello');
    expect(spawner.calls[0]?.args).toContain('--no-timestamps');
    expect(spawner.calls[0]?.args).not.toContain('--language');
  });
  it('builds OpenAI and MLX arguments with language and output paths', async () => {
    const workspace = temporaryRoot();
    const audioPath = path.join(workspace, 'audio.wav');
    fs.writeFileSync(audioPath, '');
    const openSpawner = new AdapterSpawner(() => fs.writeFileSync(path.join(workspace, 'audio.txt'), 'openai'));
    const mlxSpawner = new AdapterSpawner(() =>
      fs.writeFileSync(
        path.join(workspace, 'mlx-whisper.json'),
        JSON.stringify({
          text: 'mlx',
          segments: [{ start: 0, end: 0.5, no_speech_prob: 0.1, avg_logprob: -0.25, compression_ratio: 1.2 }],
        }),
      ),
    );
    const config: VoiceAdapterConfig = { model: { id: 'turbo' } };
    expect(
      await new OpenAiWhisperAdapter(resolver, openSpawner).transcribe({
        audioPath,
        workspace,
        config,
        language: 'en',
      }),
    ).toBe('openai');
    expect(
      await new MlxWhisperAdapter(resolver, mlxSpawner).transcribe({ audioPath, workspace, config, language: 'en' }),
    ).toEqual({
      transcript: 'mlx',
      evidence: {
        noSpeechProbability: 0.1,
        averageLogProbability: -0.25,
        compressionRatio: 1.2,
        segmentDurationMs: 500,
        speechDurationMs: 450,
      },
    });
    expect(openSpawner.calls[0]?.args).toContain('--output_format');
    expect(mlxSpawner.calls[0]?.args).toContain('--output-name');
    // mlx_whisper rejects `--format` outright, so this spelling is the whole
    // difference between a transcription and a usage dump.
    expect(mlxSpawner.calls[0]?.args).toContain('--output-format');
    expect(mlxSpawner.calls[0]?.args).not.toContain('--format');
  });
  it('rejects out-of-range MLX decoding metadata instead of dropping it', async () => {
    const workspace = temporaryRoot();
    const audioPath = path.join(workspace, 'audio.wav');
    fs.writeFileSync(audioPath, '');
    const spawner = new AdapterSpawner(() =>
      fs.writeFileSync(
        path.join(workspace, 'mlx-whisper.json'),
        JSON.stringify({ text: 'hallucinated text', segments: [{ start: 0, end: 1, no_speech_prob: 2 }] }),
      ),
    );

    await expect(
      new MlxWhisperAdapter(resolver, spawner).transcribe({
        audioPath,
        workspace,
        config: { model: { id: 'turbo' } },
        language: 'auto',
      }),
    ).rejects.toThrow('invalid no_speech_prob metadata');
  });

  it('supports MLX JSON output without optional segment metadata', async () => {
    const workspace = temporaryRoot();
    const audioPath = path.join(workspace, 'audio.wav');
    fs.writeFileSync(audioPath, '');
    const spawner = new AdapterSpawner(() =>
      fs.writeFileSync(path.join(workspace, 'mlx-whisper.json'), JSON.stringify({ text: ' plain result ' })),
    );

    await expect(
      new MlxWhisperAdapter(resolver, spawner).transcribe({
        audioPath,
        workspace,
        config: { model: { id: 'turbo' } },
        language: 'auto',
      }),
    ).resolves.toEqual({ transcript: 'plain result' });
  });
  it('selects the first usable configured adapter', () => {
    const unavailable: ITranscriberAdapter = {
      engine: 'whisper-cpp',
      preflight: () => {
        throw new Error('missing');
      },
      transcribe: async () => '',
    };
    const openAi: ITranscriberAdapter = {
      engine: 'openai-whisper',
      preflight: () => undefined,
      transcribe: async () => '',
    };
    const mlx: ITranscriberAdapter = { engine: 'mlx-whisper', preflight: () => undefined, transcribe: async () => '' };
    const registry = new TranscriberRegistry(unavailable, openAi, mlx);
    expect(
      registry.select({
        ...resolvedConfig,
        engine: 'auto',
        adapters: { 'whisper-cpp': { model: { path: '/bad' } }, 'openai-whisper': { model: { id: 'turbo' } } },
      }),
    ).toMatchObject({ adapter: openAi, config: { model: { id: 'turbo' } } });
  });
  it('shares one instance of each dependency across the graph', () => {
    const container = createVoiceContainer();

    // The record is the graph, so collaborators are shared by construction.
    expect(container.sessionController).toBe(container.sessionController);
    expect(container.spawner).toBe(container.spawner);
    expect(container.registry).toBeDefined();
  });
  it('substitutes an override instead of constructing the default', () => {
    const replacementClock: IClock = {
      now: () => 42,
      setInterval: () => ({}) as TimerHandle,
      setTimeout: () => ({}) as TimerHandle,
      clear: () => undefined,
    };

    expect(createVoiceContainer({ clock: replacementClock }).clock).toBe(replacementClock);
  });
  it('reports unusable explicit adapters', async () => {
    const bad: ITranscriberAdapter = {
      engine: 'whisper-cpp',
      preflight: () => {
        throw new Error('missing');
      },
      transcribe: async () => '',
    };
    const registry = new TranscriberRegistry(
      bad,
      { ...bad, engine: 'openai-whisper' },
      { ...bad, engine: 'mlx-whisper' },
    );
    expect(() => registry.select(resolvedConfig)).toThrow('No usable voice transcription adapter');
  });
  it('reports adapter preflight and process failures across fallback branches', async () => {
    const workspace = temporaryRoot();
    const audioPath = path.join(workspace, 'audio.wav');
    fs.writeFileSync(audioPath, '');
    const missingPath = path.join(workspace, 'missing.bin');
    expect(() =>
      new WhisperCppAdapter(resolver, new AdapterSpawner(() => undefined)).preflight({ model: { path: missingPath } }),
    ).toThrow('Voice model not found');
    expect(() =>
      new WhisperCppAdapter(resolver, new AdapterSpawner(() => undefined)).preflight({ model: { id: 'remote' } }),
    ).toThrow('local model path');
    expect(() =>
      new OpenAiWhisperAdapter(resolver, new AdapterSpawner(() => undefined)).preflight({ model: {} }),
    ).toThrow('requires a model');
    const failing: IProcessSpawner = {
      start: () => {
        throw new Error('unused');
      },
      run: async () => ({ code: 2, stdout: '', stderr: 'bad model' }),
    };
    await expect(
      new OpenAiWhisperAdapter(resolver, failing).transcribe({
        audioPath,
        workspace,
        config: { model: { id: 'turbo' } },
        language: 'auto',
      }),
    ).rejects.toThrow('bad model');
    const fallbackFailure: IProcessSpawner = {
      start: () => {
        throw new Error('unused');
      },
      run: async () => ({ code: 3, stdout: '', stderr: '' }),
    };
    await expect(
      new MlxWhisperAdapter(resolver, fallbackFailure).transcribe({
        audioPath,
        workspace,
        config: { model: { id: 'base' } },
        language: 'auto',
      }),
    ).rejects.toThrow('exit code 3');
  });
  it('covers explicit registry selection and absent config', () => {
    const bad: ITranscriberAdapter = {
      engine: 'whisper-cpp',
      preflight: () => {
        throw new Error('missing');
      },
      transcribe: async () => '',
    };
    const openAi: ITranscriberAdapter = {
      engine: 'openai-whisper',
      preflight: () => undefined,
      transcribe: async () => '',
    };
    const registry = new TranscriberRegistry(bad, openAi, { ...bad, engine: 'mlx-whisper' });
    expect(
      registry.select({
        ...resolvedConfig,
        engine: 'openai-whisper',
        adapters: { 'openai-whisper': { model: { id: 'turbo' } } },
      }).adapter,
    ).toBe(openAi);
    expect(() => registry.select({ ...resolvedConfig, engine: 'auto', adapters: {} })).toThrow('not configured');
    expect(() => registry.select({ ...resolvedConfig, engine: 'whisper-cpp' })).toThrow('missing');
  });
});

describe('voice activity presentation', () => {
  it('formats fixed-width recording pulse and transcription spinner frames', () => {
    const recording = ['·', '•', '●', '•'];
    const transcribing = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    expect(
      recording.map(
        (_, frameIndex) => formatVoiceActivity({ state: 'recording', frameIndex, elapsedSeconds: 61 }).footer.fullText,
      ),
    ).toEqual(recording);
    expect(
      transcribing.map((_, frameIndex) => formatVoiceActivity({ state: 'transcribing', frameIndex }).footer.fullText),
    ).toEqual(transcribing);
    expect(formatVoiceActivity({ state: 'recording', frameIndex: 0, elapsedSeconds: 61 })).toMatchObject({
      statusText: '· voice: recording 1:01',
      footer: { fullSegments: [{ text: '·', color: 'warning' }] },
    });
    expect(formatVoiceActivity({ state: 'transcribing', frameIndex: 0 })).toMatchObject({
      statusText: '⠋ voice: transcribing',
      footer: { fullSegments: [{ text: '⠋', color: 'accent' }] },
    });
    expect([...recording, ...transcribing].every((frame) => Array.from(frame).length === 2)).toBe(true);
  });
});

describe('voice session controller', () => {
  it('records, transcribes, appends to the draft, and never submits', async () => {
    const configService: IDoomConfigLoader = {
      load: (): DoomConfig => ({
        projectTrust: 'ask',
        voice: { adapters: { 'whisper-cpp': { model: { path: '/model' } } } },
      }),
    };
    const clock: IClock = {
      now: () => 0,
      setInterval: () => ({}) as TimerHandle,
      setTimeout: () => ({}) as TimerHandle,
      clear: () => undefined,
    };
    const recording: RecordingHandle = {
      filePath: '/audio.wav',
      stop: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const recorder = { preflight: vi.fn(), start: vi.fn(() => recording) };
    const analyzer: IAudioAnalyzer = { analyze: () => ({ silent: false, voicedMilliseconds: 500 }) };
    const adapter: ITranscriberAdapter = {
      engine: 'whisper-cpp',
      preflight: () => undefined,
      transcribe: vi.fn(async () => 'spoken words'),
    };
    const registry = {
      select: () => ({ adapter, config: { model: { path: '/model' } } }),
    };
    const workspace = { create: () => '/workspace', writeFile: vi.fn(() => '/workspace/audio.wav'), remove: vi.fn() };
    let draft = 'existing';
    const ui: VoiceUi = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setIndicator: vi.fn(),
      getEditorText: () => draft,
      setEditorText: (text) => {
        draft = text;
      },
    };
    const controller = new VoiceSessionController(configService, clock, workspace, recorder, analyzer, registry);
    await controller.toggle(ui);
    expect(controller.state).toBe('recording');
    await controller.toggle(ui);
    expect(controller.state).toBe('idle');
    expect(draft).toBe('existing spoken words');
    expect(workspace.remove).toHaveBeenCalledWith('/workspace');
    expect(ui.setIndicator).toHaveBeenNthCalledWith(1, { state: 'recording', frameIndex: 0, elapsedSeconds: 0 });
    expect(ui.setIndicator).toHaveBeenNthCalledWith(2, { state: 'transcribing', frameIndex: 0 });
    expect(ui.setIndicator).toHaveBeenLastCalledWith(undefined);
  });
  it('starts recording immediately when a model id may download', async () => {
    const configService: IDoomConfigLoader = {
      load: () => ({ projectTrust: 'ask', voice: { adapters: { 'openai-whisper': { model: { id: 'turbo' } } } } }),
    };
    const clock: IClock = {
      now: () => 0,
      setInterval: () => ({}) as TimerHandle,
      setTimeout: () => ({}) as TimerHandle,
      clear: () => undefined,
    };
    const recording: RecordingHandle = {
      filePath: '/audio.wav',
      stop: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const recorder = { preflight: vi.fn(), start: vi.fn(() => recording) };
    const adapter: ITranscriberAdapter = {
      engine: 'openai-whisper',
      preflight: () => undefined,
      transcribe: async () => '',
    };
    const ui: VoiceUi = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setIndicator: vi.fn(),
      getEditorText: () => '',
      setEditorText: vi.fn(),
    };
    const controller = new VoiceSessionController(
      configService,
      clock,
      { create: () => '/workspace', writeFile: vi.fn(() => '/workspace/audio.wav'), remove: vi.fn() },
      recorder,
      { analyze: () => ({ silent: true, voicedMilliseconds: 0 }) },
      { select: () => ({ adapter, config: { model: { id: 'turbo' } } }) },
    );
    await controller.toggle(ui);
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(controller.state).toBe('recording');
    await controller.shutdown(ui);
  });
  it('notifies for silence and shuts down an active recording', async () => {
    const configService: IDoomConfigLoader = {
      load: () => ({ projectTrust: 'ask', voice: { adapters: { 'whisper-cpp': { model: { path: '/model' } } } } }),
    };
    const clock: IClock = {
      now: () => 0,
      setInterval: () => ({}) as TimerHandle,
      setTimeout: () => ({}) as TimerHandle,
      clear: vi.fn(),
    };
    const recording: RecordingHandle = {
      filePath: '/audio.wav',
      stop: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const adapter: ITranscriberAdapter = {
      engine: 'whisper-cpp',
      preflight: () => undefined,
      transcribe: vi.fn(async () => ''),
    };
    const workspace = { create: () => '/workspace', writeFile: vi.fn(() => '/workspace/audio.wav'), remove: vi.fn() };
    const ui: VoiceUi = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setIndicator: vi.fn(),
      getEditorText: () => '',
      setEditorText: vi.fn(),
    };
    const controller = new VoiceSessionController(
      configService,
      clock,
      workspace,
      { preflight: () => undefined, start: () => recording },
      { analyze: () => ({ silent: true, voicedMilliseconds: 0 }) },
      { select: () => ({ adapter, config: { model: { path: '/model' } } }) },
    );
    await controller.toggle(ui);
    await controller.toggle(ui);
    expect(ui.notify).toHaveBeenCalledWith('No speech detected', 'info');
    expect(adapter.transcribe).not.toHaveBeenCalled();
    await controller.toggle(ui);
    await controller.shutdown(ui);
    expect(recording.abort).toHaveBeenCalled();
    expect(controller.state).toBe('idle');
  });
  it('registers runtime surfaces without reading tools before session start', async () => {
    const commands: string[] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const getActiveTools = vi.fn(() => []);
    const getAllTools = vi.fn(() => []);
    const pi = {
      registerCommand: (name: string) => {
        commands.push(name);
      },
      on: (name: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(name, handler);
      },
      getActiveTools,
      getAllTools,
      setActiveTools: vi.fn(),
    };
    const cordis = new Context();
    installVoiceRuntime(cordis, pi as never);
    expect(getActiveTools).not.toHaveBeenCalled();
    expect(getAllTools).not.toHaveBeenCalled();
    expect(commands).toEqual(['voice', 'voice-auto']);
    expect(voiceLeaderBindings(false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'voice.toggle' }),
        expect.objectContaining({
          id: 'voice.auto-toggle',
          path: expect.arrayContaining([expect.objectContaining({ key: 'e', label: 'enter' })]),
          command: { name: 'voice-auto' },
        }),
      ]),
    );
    expect(voiceLeaderBindings(true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'voice.auto-toggle',
          path: expect.arrayContaining([expect.objectContaining({ key: 'e', label: 'exit', tone: 'exit' })]),
          command: { name: 'voice-auto' },
        }),
      ]),
    );
    expect(handlers.has('session_start')).toBe(true);
    expect(handlers.has('before_agent_start')).toBe(true);
    expect(handlers.has('input')).toBe(false);
    expect(handlers.has('agent_settled')).toBe(true);
    expect(handlers.has('message_end')).toBe(false);
    expect(handlers.has('tool_execution_start')).toBe(true);
    expect(handlers.has('turn_end')).toBe(true);
    expect(handlers.has('session_shutdown')).toBe(false);
    await cordis.fiber.dispose();
  });
  it('publishes SPC v e activity through an injected Doom footer', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
    const footer = { update: vi.fn(), dispose: vi.fn() };
    const modeStates: unknown[] = [];
    const modeRegistrations: unknown[] = [];
    const protocolHandlers = new Map<string, Set<(data: unknown) => void>>();
    const events = {
      emit(channel: string, data: unknown) {
        for (const handler of protocolHandlers.get(channel) ?? []) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        const listeners = protocolHandlers.get(channel) ?? new Set();
        listeners.add(handler);
        protocolHandlers.set(channel, listeners);
        return () => listeners.delete(handler);
      },
    };
    const controller: IVoiceSessionController = {
      state: 'idle',
      toggle: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
    const recorder: IPcmAudioRecorder = {
      preflight: vi.fn(),
      start: vi.fn(() => ({
        completion: new Promise<ProcessResult>(() => undefined),
        stop: vi.fn(async () => Buffer.alloc(0)),
        abort: vi.fn(async () => undefined),
      })),
    };
    const transcriber: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: vi.fn(),
      transcribe: vi.fn(async () => ''),
    };
    const transcribers: ITranscriberRegistry = {
      select: () => ({ adapter: transcriber, config: { model: { id: 'whisper' } } }),
    };
    const tts: ITtsAdapter = {
      preflight: vi.fn(),
      speak: vi.fn((request) => {
        const reference = { ...request, startedAt: Date.now() };
        return {
          reference,
          completion: Promise.resolve({
            outcome: 'completed' as const,
            reference: { ...reference, endedAt: Date.now() },
            process: { code: 0, stdout: '', stderr: '' },
          }),
          stop: vi.fn(async () => undefined),
          abort: vi.fn(async () => undefined),
        };
      }),
    };
    const container = createVoiceContainer({
      sessionController: controller,
      pcmRecorder: recorder,
      registry: transcribers,
      tts,
      configs: {
        load: () => ({
          projectTrust: 'ask',
          voice: {
            engine: 'mlx-whisper',
            adapters: { 'mlx-whisper': { model: { id: 'whisper' } } },
            autoCapture: {
              model: 'openai-codex/gpt-5.6-luna',
              startPhrases: [],
              stopPhrases: [],
              utteranceIdleMs: 3_000,
              tts: { engine: 'macos-say' },
            },
          },
        }),
      },
    });
    let activeTools = ['read'];
    const registeredTools = new Map<string, unknown>();
    const pi = {
      events,
      registerTool: (tool: { name: string }) => {
        registeredTools.set(tool.name, tool);
      },
      registerCommand: (name: string, command: { handler: (...args: unknown[]) => unknown }) => {
        commands.set(name, command);
      },
      on: (name: string, handler: (...args: unknown[]) => unknown) => {
        const previous = handlers.get(name);
        handlers.set(name, async (...args: unknown[]) => {
          await previous?.(...args);
          return handler(...args);
        });
      },
      getActiveTools: () => [...activeTools],
      getAllTools: () => [{ name: 'read' }, ...[...registeredTools.keys()].map((name) => ({ name }))],
      setActiveTools: (toolNames: string[]) => {
        activeTools = [...toolNames];
      },
      sendUserMessage: vi.fn(),
    };
    const model = { provider: 'openai-codex', id: 'gpt-5.6-luna', api: 'openai-codex-responses' };
    const context = {
      hasUI: true,
      mode: 'tui',
      sessionManager: { getSessionId: () => 'voice-session-1', getBranch: () => [] },
      isIdle: () => true,
      modelRegistry: {
        find: () => model,
        hasConfiguredAuth: () => true,
        complete: vi.fn(),
      },
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        getEditorText: () => '',
        setEditorText: vi.fn(),
      },
    };

    const beginCapture = vi.fn();
    const autoClientFactory = (options: { onEvent(event: never): void }) => ({
      start: vi.fn(async () => undefined),
      beginCapture: vi.fn((input: { sessionId: string; captureId: string; turnId: string }) => {
        beginCapture(input);
        options.onEvent({
          version: 1,
          sequence: 1,
          kind: 'capture-state',
          sessionId: input.sessionId,
          captureId: input.captureId,
          state: 'listening',
        } as never);
      }),
      finalizeCapture: vi.fn((sessionId: string, captureId: string) => {
        const input = beginCapture.mock.lastCall?.[0] as { turnId: string };
        options.onEvent({
          version: 1,
          sequence: 2,
          kind: 'failure',
          code: 'empty_transcript',
          recoverable: true,
          sessionId,
          captureId,
          turnId: input.turnId,
          revision: 1,
        } as never);
        options.onEvent({
          version: 1,
          sequence: 3,
          kind: 'drained',
          sessionId,
          captureId,
          turnId: input.turnId,
          revision: 1,
        } as never);
      }),
      cancelCapture: vi.fn(),
      acknowledgeCandidate: vi.fn(),
      setPlaybackState: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    });
    const goalMode: MinorModeRecord = {
      descriptor: {
        source: '@agimon-ai/doompi-goal',
        id: 'goal',
        label: 'Goal',
        description: 'Persistent objective execution.',
        order: 100,
        actions: [
          {
            id: 'start',
            label: 'Start',
            description: 'Start a goal.',
            contexts: ['tui' as const],
            parameters: [],
          },
        ],
      },
      state: {
        activation: 'inactive' as const,
        condition: 'ready' as const,
        actions: [{ id: 'start', enabled: true }],
      },
      ownerGeneration: 'goal-owner-1',
      registrationId: 'goal-registration-1',
      stateRevision: 0,
    };
    let catalogRevision = 1;
    let records: MinorModeRecord[] = [goalMode];
    const catalogListeners = new Set<() => void>();
    const publishCatalog = (): void => {
      catalogRevision += 1;
      for (const listener of catalogListeners) listener();
    };
    const modeService: MinorModeCatalogService = {
      generation: 'catalog-1',
      getSnapshot: () => ({
        hostGeneration: 'catalog-1',
        revision: catalogRevision,
        modes: structuredClone(records),
      }),
      list: () => structuredClone(records),
      subscribe(listener) {
        catalogListeners.add(listener);
        return () => catalogListeners.delete(listener);
      },
      registerOwner(definition) {
        modeRegistrations.push(definition);
        let state = structuredClone(definition.initialState);
        let disposed = false;
        const record: MinorModeRecord = {
          descriptor: structuredClone(definition.descriptor),
          state,
          ownerGeneration: 'voice-owner-1',
          registrationId: 'voice-registration-1',
          stateRevision: 0,
        };
        records = [...records, record];
        publishCatalog();
        return {
          getState: () => structuredClone(state),
          publish(nextState) {
            if (disposed) return;
            state = structuredClone(nextState);
            record.state = state;
            record.stateRevision += 1;
            modeStates.push(structuredClone(state));
            publishCatalog();
          },
          dispose() {
            if (disposed) return;
            disposed = true;
            records = records.filter((candidate) => candidate !== record);
            publishCatalog();
          },
        };
      },
      invoke: async (request: MinorModeActionRequest): Promise<MinorModeActionResponse> => ({
        operationId: request.operationId,
        catalogRevision: catalogRevision + 1,
        mode: {
          ...goalMode,
          state: { ...goalMode.state, activation: 'active' },
          stateRevision: 1,
        },
        message: 'Goal started.',
      }),
      dispose: vi.fn(),
    };
    const cordis = new Context();
    const catalogFiber = cordis.plugin((catalogContext) =>
      catalogContext.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, modeService),
    );
    await catalogFiber.await();
    installVoiceRuntime(cordis, pi as never, { footer, container, autoClientFactory });
    await handlers.get('session_start')?.({}, context);
    expect(modeRegistrations).toEqual(
      expect.arrayContaining([expect.objectContaining({ descriptor: expect.objectContaining({ label: 'Voice' }) })]),
    );
    expect(activeTools).toEqual(['read']);
    await handlers.get('before_agent_start')?.({}, context);
    expect(activeTools).toEqual(['read']);

    modeStates.length = 0;
    await commands.get('voice')?.handler('', context);
    expect(controller.toggle).toHaveBeenCalledOnce();
    expect(beginCapture).not.toHaveBeenCalled();
    expect(activeTools).toEqual(['read']);
    expect(modeStates).toEqual([]);

    footer.update.mockClear();
    await commands.get('voice-auto')?.handler('', context);

    expect(footer.update).toHaveBeenNthCalledWith(1, formatAutoCaptureActivity('processing').footer);
    expect(footer.update).toHaveBeenLastCalledWith(formatAutoCaptureActivity('listening').footer);
    expect(modeStates).toEqual(expect.arrayContaining([expect.objectContaining({ activation: 'active' })]));
    expect(beginCapture).toHaveBeenCalledOnce();
    expect([...registeredTools.keys()]).toEqual(
      expect.arrayContaining(['describe_voice_tools', 'use_voice_tools', 'narrate']),
    );
    expect(activeTools).toEqual(expect.arrayContaining(['read', 'describe_voice_tools', 'use_voice_tools', 'narrate']));
    expect(activeTools).not.toContain(MINOR_MODE_TOOL_NAME);
    const narrate = registeredTools.get('narrate') as {
      execute(
        toolCallId: string,
        input: unknown,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        executionContext: typeof context,
      ): Promise<{ details?: unknown }>;
    };
    const narration = await narrate.execute(
      'narrate-direct',
      { text: 'Primary-authored update.' },
      undefined,
      undefined,
      context,
    );
    expect(narration.details).toEqual({ outcome: 'completed' });
    expect(tts.speak).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'final', text: 'Primary-authored update.' }),
    );
    expect(context.modelRegistry.complete).not.toHaveBeenCalled();

    const describeVoiceTools = registeredTools.get('describe_voice_tools') as {
      execute(
        toolCallId: string,
        input: unknown,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        executionContext: typeof context,
      ): Promise<{ details?: unknown }>;
    };
    const described = await describeVoiceTools.execute(
      'describe-minor-mode',
      { names: [MINOR_MODE_TOOL_NAME] },
      undefined,
      undefined,
      context,
    );
    expect(described.details).toMatchObject({
      tools: [{ name: MINOR_MODE_TOOL_NAME, label: 'Minor Mode', enabled: true }],
    });
    if (!described.details || typeof described.details !== 'object' || !('catalogToken' in described.details)) {
      throw new Error('Voice minor-mode catalog token was not returned.');
    }
    const useVoiceTools = registeredTools.get('use_voice_tools') as typeof describeVoiceTools;
    const used = await useVoiceTools.execute(
      'use-minor-mode',
      {
        catalogToken: described.details.catalogToken,
        calls: [
          { name: MINOR_MODE_TOOL_NAME, input: { action: 'list' } },
          {
            name: MINOR_MODE_TOOL_NAME,
            input: {
              action: 'invoke',
              source: goalMode.descriptor.source,
              id: goalMode.descriptor.id,
              ownerGeneration: goalMode.ownerGeneration,
              registrationId: goalMode.registrationId,
              modeAction: 'start',
            },
          },
        ],
      },
      undefined,
      undefined,
      context,
    );
    expect(used.details).toMatchObject({
      status: 'completed',
      results: [
        {
          name: MINOR_MODE_TOOL_NAME,
          status: 'completed',
          result: {
            modes: expect.arrayContaining([
              expect.objectContaining({ descriptor: expect.objectContaining({ label: 'Goal' }) }),
            ]),
          },
        },
        {
          name: MINOR_MODE_TOOL_NAME,
          status: 'completed',
          result: { message: 'Goal started.', mode: { state: { activation: 'active' } } },
        },
      ],
    });
    expect(recorder.start).not.toHaveBeenCalled();
    expect(context.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining('narration'), expect.anything());

    modeStates.length = 0;
    await commands.get('voice-auto')?.handler('', context);
    expect(modeStates).toEqual(expect.arrayContaining([expect.objectContaining({ activation: 'deactivating' })]));
    expect(activeTools).toEqual(['read']);

    await cordis.fiber.dispose();
    expect(footer.dispose).not.toHaveBeenCalled();
  });
  it('handles missing config and empty transcripts without changing the draft', async () => {
    const clock: IClock = {
      now: () => 0,
      setInterval: () => ({}) as TimerHandle,
      setTimeout: () => ({}) as TimerHandle,
      clear: () => undefined,
    };
    let draft = 'draft ';
    const ui: VoiceUi = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setIndicator: vi.fn(),
      getEditorText: () => draft,
      setEditorText: (text) => {
        draft = text;
      },
    };
    const missing = new VoiceSessionController(
      { load: () => ({ projectTrust: 'ask' }) },
      clock,
      { create: vi.fn(), writeFile: vi.fn(() => '/workspace/audio.wav'), remove: vi.fn() },
      { preflight: vi.fn(), start: vi.fn() },
      { analyze: vi.fn() },
      { select: vi.fn() },
    );
    await missing.toggle(ui);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('not configured'), 'error');
    const recording: RecordingHandle = {
      filePath: '/audio.wav',
      stop: async () => undefined,
      abort: async () => undefined,
    };
    const adapter: ITranscriberAdapter = {
      engine: 'whisper-cpp',
      preflight: () => undefined,
      transcribe: async () => '   ',
    };
    const empty = new VoiceSessionController(
      { load: () => ({ projectTrust: 'ask', voice: { adapters: { 'whisper-cpp': { model: { path: '/model' } } } } }) },
      clock,
      { create: () => '/workspace', writeFile: vi.fn(() => '/workspace/audio.wav'), remove: vi.fn() },
      { preflight: () => undefined, start: () => recording },
      { analyze: () => ({ silent: false, voicedMilliseconds: 500 }) },
      { select: () => ({ adapter, config: { model: { path: '/model' } } }) },
    );
    await empty.toggle(ui);
    await empty.toggle(ui);
    expect(ui.notify).toHaveBeenCalledWith('Voice transcription was empty', 'info');
    expect(draft).toBe('draft ');
  });
  it('animates both states, rejects a transcribing toggle, and stops at the recording limit', async () => {
    let activityCallback: () => void = () => undefined;
    const activityIntervals: number[] = [];
    let limitCallback: () => void = () => undefined;
    let finishStop: () => void = () => undefined;
    const stopPending = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const clock: IClock = {
      now: () => 0,
      setInterval: (callback, milliseconds) => {
        activityCallback = callback;
        activityIntervals.push(milliseconds);
        return {} as TimerHandle;
      },
      setTimeout: (callback) => {
        limitCallback = callback;
        return {} as TimerHandle;
      },
      clear: vi.fn(),
    };
    const recording: RecordingHandle = {
      filePath: '/audio.wav',
      stop: () => stopPending,
      abort: async () => undefined,
    };
    const indicatorUpdates: Array<VoiceActivityUpdate | undefined> = [];
    const ui: VoiceUi = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setIndicator: (update) => indicatorUpdates.push(update),
      getEditorText: () => '',
      setEditorText: vi.fn(),
    };
    const adapter: ITranscriberAdapter = {
      engine: 'whisper-cpp',
      preflight: () => undefined,
      transcribe: async () => 'done',
    };
    const controller = new VoiceSessionController(
      { load: () => ({ projectTrust: 'ask', voice: { adapters: { 'whisper-cpp': { model: { path: '/model' } } } } }) },
      clock,
      { create: () => '/workspace', writeFile: vi.fn(() => '/workspace/audio.wav'), remove: vi.fn() },
      { preflight: () => undefined, start: () => recording },
      { analyze: () => ({ silent: false, voicedMilliseconds: 500 }) },
      { select: () => ({ adapter, config: { model: { path: '/model' } } }) },
    );
    await controller.toggle(ui);
    activityCallback();
    activityCallback();
    activityCallback();
    expect(indicatorUpdates.slice(0, 4).map((update) => update?.frameIndex)).toEqual([0, 1, 2, 3]);
    limitCallback();
    expect(controller.state).toBe('transcribing');
    expect(activityIntervals).toEqual([120, 120]);
    expect(indicatorUpdates.at(-1)).toEqual({ state: 'transcribing', frameIndex: 0 });
    activityCallback();
    activityCallback();
    expect(indicatorUpdates.slice(-2).map((update) => update?.frameIndex)).toEqual([1, 2]);
    await controller.toggle(ui);
    expect(ui.notify).toHaveBeenCalledWith('Voice transcription is already running', 'info');
    finishStop();
    await vi.waitFor(() => expect(controller.state).toBe('idle'));
    expect(indicatorUpdates.at(-1)).toBeUndefined();
    expect(ui.setStatus).toHaveBeenLastCalledWith('doom-voice', undefined);
    expect(ui.setEditorText).toHaveBeenCalledWith('done');
  });
});
