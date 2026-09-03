import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web/wasm';
import { SILERO_STATE_SAMPLES, SileroVadFrames } from '../src/web/sileroVadFrames.ts';

function readScaledFixture(): Uint8Array {
  const wav = fs.readFileSync(new URL('./fixtures/silero-speech.wav', import.meta.url));
  const dataOffset = wav.indexOf(Buffer.from('data'));
  if (dataOffset < 0) throw new Error('Silero WAV fixture is missing its data chunk.');
  const length = wav.readUInt32LE(dataOffset + 4);
  const pcm = wav.subarray(dataOffset + 8, dataOffset + 8 + length);
  const scaled = new Uint8Array(pcm.length);
  const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const output = new DataView(scaled.buffer);
  for (let offset = 0; offset < pcm.length; offset += 2)
    output.setInt16(offset, Math.round(input.getInt16(offset, true) * 0.03), true);
  return scaled;
}

function highEnergyTyping(byteLength: number): Uint8Array {
  const pcm = new Uint8Array(byteLength);
  const view = new DataView(pcm.buffer);
  for (let sample = 0; sample < byteLength / 2; sample += 1) {
    const phase = sample % 3_200;
    const value = phase < 160 ? 12_000 * Math.exp(-phase / 28) * (phase % 2 === 0 ? 1 : -1) : 0;
    view.setInt16(sample * 2, Math.round(value), true);
  }
  return pcm;
}

describe('browser Silero pinned-model golden PCM', () => {
  it('detects the repository speech fixture and rejects equal-length silence', async () => {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const model = fs.readFileSync(new URL('../src/web/models/silero_vad_v6.2.1.onnx', import.meta.url));
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    const detector = new SileroVadFrames(async (input, state) => {
      const result = await session.run({
        input: new ort.Tensor('float32', input, [1, 576]),
        state: new ort.Tensor('float32', state, [2, 1, 128]),
        sr: new ort.Tensor('int64', BigInt64Array.of(16_000n), []),
      });
      const stateN = result.stateN?.data;
      if (!(stateN instanceof Float32Array) || stateN.length !== SILERO_STATE_SAMPLES)
        throw new Error('Golden Silero inference returned invalid recurrent state.');
      return { probability: Number(result.output?.data[0]), state: stateN };
    });
    const speech = readScaledFixture();

    const speechWindows = await detector.push(speech);
    expect(speechWindows.filter((window) => window.speech).length).toBeGreaterThanOrEqual(4);
    detector.reset();
    const silenceWindows = await detector.push(new Uint8Array(speech.length));
    expect(silenceWindows.some((window) => window.speech)).toBe(false);
    detector.reset();
    const typingWindows = await detector.push(highEnergyTyping(speech.length));
    expect(typingWindows.some((window) => window.speech)).toBe(false);
  });
});
