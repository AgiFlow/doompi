import { startManualBrowserRecording, type ManualBrowserRecording } from './manualBrowserRecorder.ts';
import { transcribeManualRecording } from './manualTranscriptionClient.ts';

export type ManualComposerPhase = 'idle' | 'starting' | 'recording' | 'transcribing';

export interface ManualComposerRecorderState {
  phase: ManualComposerPhase;
  error?: string;
}

interface ManualComposerRecorderDependencies {
  start: () => Promise<ManualBrowserRecording>;
  transcribe: (audio: Blob, sessionId: string, durationMs: number, signal: AbortSignal) => Promise<string>;
}

const DEFAULT_DEPENDENCIES: ManualComposerRecorderDependencies = {
  start: startManualBrowserRecording,
  transcribe: async (audio, sessionId, durationMs, signal) =>
    await transcribeManualRecording(audio, sessionId, durationMs, undefined, signal),
};

/** Coordinates one button-only manual recording without touching autonomous voice services. */
export class ManualComposerRecorder {
  private state: ManualComposerRecorderState = { phase: 'idle' };
  private recording: ManualBrowserRecording | undefined;
  private transcription: AbortController | undefined;
  private generation = 0;

  public constructor(
    private append: (text: string) => void,
    private readonly changed: () => void,
    private readonly dependencies: ManualComposerRecorderDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  public snapshot(): ManualComposerRecorderState {
    return this.state;
  }

  public setAppend(append: (text: string) => void): void {
    this.append = append;
  }

  public reset(): void {
    this.invalidate();
    this.publish({ phase: 'idle' });
  }

  public dispose(): void {
    this.invalidate();
    this.state = { phase: 'idle' };
  }

  public async toggle(sessionId: string | null): Promise<void> {
    if (sessionId === null || this.state.phase === 'starting' || this.state.phase === 'transcribing') return;
    if (this.state.phase === 'recording') {
      this.publish({ phase: 'transcribing' });
      this.recording?.stop();
      return;
    }

    const append = this.append;
    const token = ++this.generation;
    this.publish({ phase: 'starting' });
    try {
      const recording = await this.dependencies.start();
      if (this.generation !== token) {
        recording.cancel();
        return;
      }
      this.recording = recording;
      this.publish({ phase: 'recording' });
      void this.finish(recording, token, sessionId, append);
    } catch (error) {
      if (this.generation !== token) return;
      this.publish({ phase: 'idle', error: error instanceof Error ? error.message : 'Voice recording failed.' });
    }
  }

  private async finish(
    recording: ManualBrowserRecording,
    token: number,
    sessionId: string,
    append: (text: string) => void,
  ): Promise<void> {
    let transcription: AbortController | undefined;
    try {
      const result = await recording.result;
      if (result === undefined || this.generation !== token) return;
      if (this.recording === recording) this.recording = undefined;
      this.publish({ phase: 'transcribing' });
      transcription = new AbortController();
      this.transcription = transcription;
      const transcript = await this.dependencies.transcribe(
        result.audio,
        sessionId,
        result.durationMs,
        transcription.signal,
      );
      if (this.generation !== token) return;
      append(transcript);
      this.publish({ phase: 'idle' });
    } catch (error) {
      if (this.generation !== token) return;
      if (this.recording === recording) this.recording = undefined;
      this.publish({ phase: 'idle', error: error instanceof Error ? error.message : 'Voice recording failed.' });
    } finally {
      if (transcription !== undefined && this.transcription === transcription) this.transcription = undefined;
    }
  }

  private invalidate(): void {
    this.generation += 1;
    this.recording?.cancel();
    this.recording = undefined;
    this.transcription?.abort();
    this.transcription = undefined;
  }

  private publish(state: ManualComposerRecorderState): void {
    this.state = state;
    this.changed();
  }
}
