import type {
  IClock,
  ITemporaryWorkspace,
  ITranscriberRegistry,
  TimerHandle,
  TranscriptionAdapterOutput,
} from '../types/index.ts';
import {
  MANUAL_TRANSCRIPTION_MAX_TRANSCRIPT_BYTES,
  MANUAL_TRANSCRIPTION_TIMEOUT_MS,
  type IEncodedAudioDecoder,
  type IManualTranscriptionConfigLoader,
  type IManualTranscriptionService,
  ManualTranscriptionError,
  type ManualTranscriptionMediaType,
  type ManualTranscriptionResult,
} from '../types/manualTranscription.ts';

function transcriptOf(output: TranscriptionAdapterOutput): string {
  return typeof output === 'string' ? output : output.transcript;
}

export class ManualTranscriptionService implements IManualTranscriptionService {
  public constructor(
    private readonly configs: IManualTranscriptionConfigLoader,
    private readonly decoder: IEncodedAudioDecoder,
    private readonly registry: ITranscriberRegistry,
    private readonly workspaces: ITemporaryWorkspace,
    private readonly clock: IClock,
  ) {}

  public async transcribe(
    audio: Buffer,
    mediaType: ManualTranscriptionMediaType,
    signal?: AbortSignal,
  ): Promise<ManualTranscriptionResult> {
    const config = this.configs.load();
    const selected = this.registry.select(config);
    const workspace = this.workspaces.create();
    let cleanupDeferred = false;
    let cancel: (() => void) | undefined;
    try {
      const audioPath = await this.decoder.decode(audio, mediaType, workspace, config.recorder.binary, signal);
      if (signal?.aborted) throw new Error('Voice transcription was cancelled.');
      const controller = new AbortController();
      const cancelled =
        signal === undefined
          ? undefined
          : new Promise<never>((_resolve, reject) => {
              cancel = () => {
                reject(new Error('Voice transcription was cancelled.'));
                controller.abort();
              };
              signal.addEventListener('abort', cancel, { once: true });
              if (signal.aborted) cancel();
            });
      const transcription = selected.adapter.transcribe({
        audioPath,
        workspace,
        config: selected.config,
        language: config.language,
        signal: controller.signal,
      });
      let timeout!: TimerHandle;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = this.clock.setTimeout(() => {
          reject(new ManualTranscriptionError('timeout', 'Voice transcription timed out.'));
          controller.abort();
        }, MANUAL_TRANSCRIPTION_TIMEOUT_MS);
      });
      try {
        const output = await Promise.race([transcription, timedOut, ...(cancelled === undefined ? [] : [cancelled])]);
        const transcript = transcriptOf(output).trim();
        if (transcript.length === 0)
          throw new ManualTranscriptionError('empty_transcript', 'Voice transcription was empty.');
        if (Buffer.byteLength(transcript, 'utf8') > MANUAL_TRANSCRIPTION_MAX_TRANSCRIPT_BYTES)
          throw new ManualTranscriptionError('output_too_large', 'Voice transcription output exceeded its limit.');
        return { transcript };
      } catch (error) {
        if (controller.signal.aborted) {
          cleanupDeferred = true;
          void transcription
            .then(
              () => this.workspaces.remove(workspace),
              () => this.workspaces.remove(workspace),
            )
            .catch(() => undefined);
        }
        throw error;
      } finally {
        this.clock.clear(timeout);
      }
    } finally {
      if (cancel !== undefined) signal?.removeEventListener('abort', cancel);
      if (!cleanupDeferred) this.workspaces.remove(workspace);
    }
  }
}
