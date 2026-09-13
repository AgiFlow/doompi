import { resolveVoiceConfig } from '@agimon-ai/doompi-config/config';
import { type IDoomConfigLoader, type ResolvedVoiceConfig } from '@agimon-ai/doompi-config/types';
import { DOOM_VOICE_SOURCE as VOICE_SOURCE } from '@agimon-ai/doompi-core/voice-tools';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';

import {
  STATUS_KEY,
  MAX_RECORDING_MS,
  ACTIVITY_INTERVAL_MS,
  INFO_NOTIFICATION,
  ERROR_NOTIFICATION,
  RECORDING_REQUESTED_EVENT,
  RECORDING_STARTED_EVENT,
  RECORDING_FAILED_EVENT,
  RECORDING_FINISHED_EVENT,
  TRANSCRIPTION_STARTED_EVENT,
  TRANSCRIPTION_FINISHED_EVENT,
  TRANSCRIPTION_FAILED_EVENT,
  IDLE_STATE,
  RECORDING_STATE,
  TRANSCRIBING_STATE,
} from '../../constants/voiceRuntime';
import { formatVoiceActivity } from '../../models/voiceActivity';
import {
  type IAudioAnalyzer,
  type IAudioRecorder,
  type IClock,
  type ITemporaryWorkspace,
  type ITranscriberRegistry,
  type IVoiceSessionController,
  type RecordingHandle,
  type SelectedTranscriber,
  type TimerHandle,
  type VoiceActivityUpdate,
  type VoiceState,
  type VoiceUi,
} from '../../types';

export class VoiceSessionController implements IVoiceSessionController {
  private currentState: VoiceState = IDLE_STATE;
  private recording?: RecordingHandle;
  private workspace?: string;
  private config?: ResolvedVoiceConfig;
  private selected?: SelectedTranscriber;
  private startedAt = 0;
  private activityFrame = 0;
  private activityTimer?: TimerHandle;
  private limitTimer?: TimerHandle;
  private readonly telemetry = createDoomTelemetry({
    serviceName: STATUS_KEY,
    packageName: VOICE_SOURCE,
    env: process.env,
    enableLogs: true,
    enableTraces: true,
  });
  constructor(
    private readonly configs: IDoomConfigLoader,
    private readonly clock: IClock,
    private readonly workspaces: ITemporaryWorkspace,
    private readonly recorder: IAudioRecorder,
    private readonly analyzer: IAudioAnalyzer,
    private readonly registry: ITranscriberRegistry,
  ) {}
  get state(): VoiceState {
    return this.currentState;
  }
  async toggle(ui: VoiceUi): Promise<void> {
    if (this.currentState === TRANSCRIBING_STATE) {
      ui.notify('Voice transcription is already running', INFO_NOTIFICATION);
      return;
    }
    if (this.currentState === RECORDING_STATE) {
      await this.stopAndTranscribe(ui);
      return;
    }
    await this.startRecording(ui);
  }
  private async startRecording(ui: VoiceUi): Promise<void> {
    try {
      const projectRoot = process.env.PI_PROJECT_ROOT ?? process.cwd();
      const loaded = this.configs.load(projectRoot).voice;
      if (!loaded) throw new Error('Voice is not configured in the Pi agent configuration.');
      const config = resolveVoiceConfig(loaded);
      this.recorder.preflight(config);
      const selected = this.registry.select(config);
      void this.telemetry.recordEvent(RECORDING_REQUESTED_EVENT, {
        engine: selected.adapter.engine,
        mode: config.language,
      });
      const workspace = this.workspaces.create();
      this.recording = this.recorder.start(config, workspace);
      this.workspace = workspace;
      this.config = config;
      this.selected = selected;
      this.currentState = RECORDING_STATE;
      this.startedAt = this.clock.now();
      this.startActivity(ui);
      this.limitTimer = this.clock.setTimeout(() => {
        void this.stopAndTranscribe(ui);
      }, MAX_RECORDING_MS);
      void this.telemetry.recordEvent(RECORDING_STARTED_EVENT, {
        engine: selected.adapter.engine,
        outcome: 'started',
      });
    } catch (error) {
      await this.telemetry.recordError(RECORDING_FAILED_EVENT, error, { outcome: 'failed' });
      this.reset(ui);
      ui.notify(error instanceof Error ? error.message : String(error), ERROR_NOTIFICATION);
    }
  }
  private startActivity(ui: VoiceUi): void {
    this.activityFrame = 0;
    this.publishActivity(ui);
    this.activityTimer = this.clock.setInterval(() => {
      this.activityFrame += 1;
      this.publishActivity(ui);
    }, ACTIVITY_INTERVAL_MS);
  }
  private publishActivity(ui: VoiceUi): void {
    if (this.currentState === IDLE_STATE) return;
    const update: VoiceActivityUpdate = {
      state: this.currentState,
      frameIndex: this.activityFrame,
      ...(this.currentState === RECORDING_STATE
        ? { elapsedSeconds: Math.max(0, Math.floor((this.clock.now() - this.startedAt) / 1_000)) }
        : {}),
    };
    ui.setIndicator(update);
    ui.setStatus(STATUS_KEY, formatVoiceActivity(update).statusText);
  }
  private async stopAndTranscribe(ui: VoiceUi): Promise<void> {
    const recording = this.recording;
    const workspace = this.workspace;
    const config = this.config;
    const selected = this.selected;
    if (!recording || !workspace || !config || !selected || this.currentState !== RECORDING_STATE) return;
    this.clearTimers();
    const recordingStartedAt = this.startedAt;
    this.currentState = TRANSCRIBING_STATE;
    this.startActivity(ui);
    void this.telemetry.recordEvent(TRANSCRIPTION_STARTED_EVENT, {
      engine: selected.adapter.engine,
      duration_ms: Math.max(0, this.clock.now() - recordingStartedAt),
    });
    try {
      await recording.stop();
      const recordingDurationMs = Math.max(0, this.clock.now() - recordingStartedAt);
      if (this.analyzer.analyze(recording.filePath).silent) {
        await this.telemetry.recordEvent(TRANSCRIPTION_FINISHED_EVENT, {
          engine: selected.adapter.engine,
          duration_ms: recordingDurationMs,
          silence: true,
          outcome: 'empty',
        });
        ui.notify('No speech detected', INFO_NOTIFICATION);
        return;
      }
      const transcription = await selected.adapter.transcribe({
        audioPath: recording.filePath,
        workspace,
        config: selected.config,
        language: config.language,
      });
      const transcript = (typeof transcription === 'string' ? transcription : transcription.transcript).trim();
      if (!transcript) {
        await this.telemetry.recordEvent(TRANSCRIPTION_FINISHED_EVENT, {
          engine: selected.adapter.engine,
          duration_ms: recordingDurationMs,
          empty: true,
          outcome: 'empty',
        });
        ui.notify('Voice transcription was empty', INFO_NOTIFICATION);
        return;
      }
      const draft = ui.getEditorText?.() ?? '';
      ui.setEditorText?.(`${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}${transcript}`);
      await this.telemetry.recordEvent(TRANSCRIPTION_FINISHED_EVENT, {
        engine: selected.adapter.engine,
        duration_ms: recordingDurationMs,
        empty: false,
        outcome: 'completed',
      });
    } catch (error) {
      await this.telemetry.recordError(TRANSCRIPTION_FAILED_EVENT, error, {
        engine: selected.adapter.engine,
        duration_ms: Math.max(0, this.clock.now() - recordingStartedAt),
      });
      ui.notify(error instanceof Error ? error.message : String(error), ERROR_NOTIFICATION);
    } finally {
      this.reset(ui);
    }
  }
  async shutdown(ui?: VoiceUi): Promise<void> {
    this.clearTimers();
    if (this.recording && this.currentState === RECORDING_STATE) {
      await this.recording.abort();
      void this.telemetry.recordEvent(RECORDING_FINISHED_EVENT, { outcome: 'aborted' });
    }
    this.reset(ui);
    void this.telemetry.shutdown();
  }
  private clearTimers(): void {
    if (this.activityTimer) this.clock.clear(this.activityTimer);
    if (this.limitTimer) this.clock.clear(this.limitTimer);
    this.activityTimer = undefined;
    this.limitTimer = undefined;
  }
  private reset(ui?: VoiceUi): void {
    this.clearTimers();
    if (this.workspace) this.workspaces.remove(this.workspace);
    this.recording = undefined;
    this.workspace = undefined;
    this.config = undefined;
    this.selected = undefined;
    this.currentState = IDLE_STATE;
    this.activityFrame = 0;
    ui?.setIndicator(undefined);
    ui?.setStatus(STATUS_KEY, undefined);
  }
}
