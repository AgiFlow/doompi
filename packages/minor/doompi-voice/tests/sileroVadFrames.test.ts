import { describe, expect, it, vi } from 'vitest';
import {
  SILERO_CONTEXT_SAMPLES,
  SILERO_FRAME_SAMPLES,
  SILERO_STATE_SAMPLES,
  SileroVadFrames,
} from '../web/sileroVadFrames.ts';

function pcm(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

describe('Silero VAD framing', () => {
  it('runs exact 512-sample frames with 64 samples of carried context and recurrent state', async () => {
    const calls: Array<{ input: Float32Array; state: Float32Array }> = [];
    const infer = vi.fn(async (input: Float32Array, state: Float32Array) => {
      calls.push({ input: new Float32Array(input), state: new Float32Array(state) });
      const next = new Float32Array(SILERO_STATE_SAMPLES);
      next.fill(calls.length);
      return { probability: calls.length === 2 ? 0.5 : 0.49, state: next };
    });
    const frames = new SileroVadFrames(infer);
    const samples = Array.from({ length: SILERO_FRAME_SAMPLES * 2 }, (_, index) => index + 1);

    await expect(frames.push(pcm(samples))).resolves.toEqual([
      { speech: false, sampleCount: 512 },
      { speech: true, sampleCount: 512 },
    ]);
    expect(calls[0]?.input).toHaveLength(SILERO_CONTEXT_SAMPLES + SILERO_FRAME_SAMPLES);
    expect(Array.from(calls[0]?.input.slice(0, 64) ?? [])).toEqual(Array.from({ length: 64 }, () => 0));
    expect(calls[1]?.input[0]).toBeCloseTo((SILERO_FRAME_SAMPLES - 63) / 32_768);
    expect(calls[1]?.state[0]).toBe(1);
  });

  it('buffers partial frames and reset clears partial, context, and recurrent state', async () => {
    const calls: Array<{ input: Float32Array; state: Float32Array }> = [];
    const frames = new SileroVadFrames(async (input, state) => {
      calls.push({ input: new Float32Array(input), state: new Float32Array(state) });
      return { probability: 0, state: new Float32Array(SILERO_STATE_SAMPLES).fill(9) };
    });

    await expect(frames.push(pcm(Array.from({ length: 511 }, () => 1_000)))).resolves.toEqual([]);
    await frames.push(pcm([1_000]));
    frames.reset();
    await expect(frames.push(pcm(Array.from({ length: 512 }, () => 2_000)))).resolves.toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input.slice(0, 64).every((sample) => sample === 0)).toBe(true);
    expect(calls[1]?.state.every((sample) => sample === 0)).toBe(true);
  });
});
