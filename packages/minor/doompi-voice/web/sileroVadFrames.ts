import type { SpeechPresenceWindow } from '../src/types/clientCaptureActivity.ts';

export const SILERO_FRAME_SAMPLES = 512;
export const SILERO_CONTEXT_SAMPLES = 64;
export const SILERO_STATE_SAMPLES = 2 * 1 * 128;
export const SILERO_SPEECH_THRESHOLD = 0.5;

export type SileroFrameInference = (
  input: Float32Array,
  state: Float32Array,
) => Promise<{ probability: number; state: Float32Array }>;

/** Deterministic Silero framing and recurrent-state lifecycle, independent of ONNX Runtime. */
export class SileroVadFrames {
  private readonly context = new Float32Array(SILERO_CONTEXT_SAMPLES);
  private state = new Float32Array(SILERO_STATE_SAMPLES);
  private partial = new Float32Array(0);

  public constructor(private readonly infer: SileroFrameInference) {}

  public async push(pcm: Uint8Array): Promise<readonly SpeechPresenceWindow[]> {
    if (pcm.byteLength % 2 !== 0) throw new Error('Silero PCM input must contain complete 16-bit samples.');
    const incoming = new Float32Array(pcm.byteLength / 2);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let index = 0; index < incoming.length; index += 1) incoming[index] = view.getInt16(index * 2, true) / 32_768;

    const samples = new Float32Array(this.partial.length + incoming.length);
    samples.set(this.partial);
    samples.set(incoming, this.partial.length);
    const windows: SpeechPresenceWindow[] = [];
    let offset = 0;
    while (samples.length - offset >= SILERO_FRAME_SAMPLES) {
      const frame = samples.subarray(offset, offset + SILERO_FRAME_SAMPLES);
      const input = new Float32Array(SILERO_CONTEXT_SAMPLES + SILERO_FRAME_SAMPLES);
      input.set(this.context);
      input.set(frame, SILERO_CONTEXT_SAMPLES);
      const result = await this.infer(input, this.state);
      if (!Number.isFinite(result.probability) || result.state.length !== SILERO_STATE_SAMPLES)
        throw new Error('Silero inference returned an invalid result.');
      this.state = new Float32Array(result.state);
      this.context.set(frame.subarray(SILERO_FRAME_SAMPLES - SILERO_CONTEXT_SAMPLES));
      windows.push({ speech: result.probability >= SILERO_SPEECH_THRESHOLD, sampleCount: SILERO_FRAME_SAMPLES });
      offset += SILERO_FRAME_SAMPLES;
    }
    this.partial = new Float32Array(samples.subarray(offset));
    return windows;
  }

  public reset(): void {
    this.context.fill(0);
    this.state = new Float32Array(SILERO_STATE_SAMPLES);
    this.partial = new Float32Array(0);
  }
}
