import type { IDoomConfigLoader } from '@agimon-ai/doompi-config/types';
import type { ResolvedVoiceConfig, VoiceAdapterConfig, VoiceEngine, VoiceTtsConfig } from '@agimon-ai/doompi-config';

/** Everything the voice runtime is assembled from. */
export interface VoiceDependencies {
  readonly clock: IClock;
  readonly executables: IExecutableResolver;
  readonly spawner: IProcessSpawner;
  readonly binarySpawner: IBinaryProcessSpawner;
  readonly configs: IDoomConfigLoader;
  readonly recorder: IAudioRecorder;
  readonly pcmRecorder: IPcmAudioRecorder;
  readonly tts: ITtsAdapter;
  readonly analyzer: IAudioAnalyzer;
  readonly whisperCpp: ITranscriberAdapter;
  readonly openAiWhisper: ITranscriberAdapter;
  readonly mlxWhisper: ITranscriberAdapter;
  readonly registry: ITranscriberRegistry;
  readonly sessionController: IVoiceSessionController;
}
export type VoiceState = 'idle' | 'recording' | 'transcribing';
export type AutoCaptureActivationState = 'disabled' | 'starting' | 'active' | 'draining' | 'shuttingDown';
export type AutoCaptureIndicatorState =
  | 'listening'
  | 'speech'
  | 'processing'
  | 'narrating'
  | 'confirming'
  | 'waiting'
  | 'draining';
export type TimerHandle = ReturnType<typeof setTimeout>;
export interface IClock {
  now(): number;
  setInterval(callback: () => void, milliseconds: number): TimerHandle;
  setTimeout(callback: () => void, milliseconds: number): TimerHandle;
  clear(handle: TimerHandle): void;
}
export interface IExecutableResolver {
  resolve(configured: string | undefined, fallback: string): string;
}
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface ProcessStartOptions {
  signal?: AbortSignal;
}
export interface BinaryProcessStartOptions extends ProcessStartOptions {
  stdin?: 'ignore' | 'pipe';
}
export interface RunningProcess {
  completion: Promise<ProcessResult>;
  signal(signal: NodeJS.Signals): boolean;
}
export interface BinaryRunningProcess extends RunningProcess {
  onStdout(listener: (chunk: Buffer) => void): () => void;
  writeStdin(data: string | Buffer): boolean;
  closeStdin(): void;
}
export interface IProcessSpawner {
  start(executable: string, args: readonly string[], options?: ProcessStartOptions): RunningProcess;
  run(executable: string, args: readonly string[], options?: ProcessStartOptions): Promise<ProcessResult>;
}
export interface IBinaryProcessSpawner {
  start(executable: string, args: readonly string[], options?: BinaryProcessStartOptions): BinaryRunningProcess;
}
export interface ITemporaryWorkspace {
  create(): string;
  writeFile(directory: string, fileName: string, data: Buffer): string;
  remove(directory: string): void;
}
export interface RecordingHandle {
  filePath: string;
  stop(): Promise<void>;
  abort(): Promise<void>;
}
export interface IAudioRecorder {
  preflight(config: ResolvedVoiceConfig): void;
  start(config: ResolvedVoiceConfig, workspace: string): RecordingHandle;
}
export interface LiveRecordingHandle {
  readonly completion: Promise<ProcessResult>;
  stop(): Promise<Buffer>;
  // biome-ignore lint/suspicious/noConfusingVoidType: Public adapters may abort without buffered audio.
  abort(): Promise<Buffer | void>;
}
export interface IPcmAudioRecorder {
  preflight(config: ResolvedVoiceConfig): void;
  start(config: ResolvedVoiceConfig, onFrame: (frame: Buffer) => void): LiveRecordingHandle;
}

export interface ISpeechPresenceDetector {
  push(frame: Buffer): boolean;
  reset(): void;
}
export type NarrationKind = 'intent' | 'plan' | 'final' | 'clarification' | 'question';
export type TtsPlaybackOutcome = 'completed' | 'stopped' | 'aborted' | 'failed';
export interface TtsSpeakRequest {
  id: number;
  kind: NarrationKind;
  text: string;
  config: VoiceTtsConfig;
}
export interface TtsPlaybackReference {
  id: number;
  kind: NarrationKind;
  text: string;
  startedAt: number;
  endedAt?: number;
}
export interface TtsPlaybackResult {
  outcome: TtsPlaybackOutcome;
  reference: TtsPlaybackReference;
  process: ProcessResult;
}
export interface TtsPlayback {
  readonly reference: TtsPlaybackReference;
  readonly completion: Promise<TtsPlaybackResult>;
  stop(): Promise<void>;
  abort(): Promise<void>;
}
export interface ITtsAdapter {
  preflight(config: VoiceTtsConfig): void;
  speak(request: TtsSpeakRequest): TtsPlayback;
}
export interface AudioAnalysis {
  silent: boolean;
  voicedMilliseconds: number;
}
export interface IAudioAnalyzer {
  analyze(filePath: string): AudioAnalysis;
}
export interface TranscriptionRequest {
  audioPath: string;
  workspace: string;
  config: VoiceAdapterConfig;
  language: string;
  signal?: AbortSignal;
}
export interface ITranscriberAdapter {
  readonly engine: Exclude<VoiceEngine, 'auto'>;
  preflight(config: VoiceAdapterConfig): void;
  transcribe(request: TranscriptionRequest): Promise<string>;
}
export interface SelectedTranscriber {
  adapter: ITranscriberAdapter;
  config: VoiceAdapterConfig;
}
export interface ITranscriberRegistry {
  select(config: ResolvedVoiceConfig): SelectedTranscriber;
}
export interface VoiceActivityUpdate {
  state: Exclude<VoiceState, 'idle'>;
  frameIndex: number;
  elapsedSeconds?: number;
}
export interface VoiceUi {
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  setStatus(key: string, value: string | undefined): void;
  setIndicator(update: VoiceActivityUpdate | undefined): void;
  getEditorText(): string;
  setEditorText(text: string): void;
}
export interface AutoCaptureUi {
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  setStatus(value: string | undefined): void;
  setIndicator(state: AutoCaptureIndicatorState | undefined): void;
}
export interface IVoiceSessionController {
  readonly state: VoiceState;
  toggle(ui: VoiceUi): Promise<void>;
  shutdown(ui?: VoiceUi): Promise<void>;
}
