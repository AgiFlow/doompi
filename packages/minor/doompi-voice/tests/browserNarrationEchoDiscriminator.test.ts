import { describe, expect, it } from 'vitest';
import { BrowserNarrationEchoDiscriminator } from '../src/web/browserNarrationEchoDiscriminator.ts';

const SAMPLE_RATE = 16_000;
const CHUNK_SAMPLES = 1_600;

function signal(sampleCount: number, seed: number): Float32Array {
  let state = seed >>> 0;
  const samples = new Float32Array(sampleCount);
  let filtered = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const noise = (state / 0xffff_ffff) * 2 - 1;
    filtered = filtered * 0.82 + noise * 0.18;
    const envelope = 0.25 + 0.75 * Math.abs(Math.sin((index / SAMPLE_RATE) * Math.PI * 3.7));
    samples[index] = filtered * envelope * 0.7;
  }
  return samples;
}

function pcm(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, value < 0 ? Math.round(value * 32_768) : Math.round(value * 32_767), true);
  }
  return bytes;
}

function delayedMix(
  reference: Float32Array,
  nearEnd: Float32Array | undefined,
  delaySamples: number,
  gain: number,
): Float32Array {
  const mixed = new Float32Array(reference.length);
  for (let index = 0; index < mixed.length; index += 1)
    mixed[index] = gain * (reference[index - delaySamples] ?? 0) + (nearEnd?.[index] ?? 0);
  return mixed;
}

function chunks(samples: Float32Array): Float32Array[] {
  const result: Float32Array[] = [];
  for (let offset = 0; offset < samples.length; offset += CHUNK_SAMPLES)
    result.push(samples.slice(offset, offset + CHUNK_SAMPLES));
  return result;
}

function processAll(
  discriminator: BrowserNarrationEchoDiscriminator,
  samples: Float32Array,
  startedAt = 0,
): ReturnType<BrowserNarrationEchoDiscriminator['process']>[] {
  return chunks(samples).map((chunk, index) =>
    discriminator.process(pcm(chunk), startedAt + ((index + 1) * CHUNK_SAMPLES) / SAMPLE_RATE),
  );
}

describe('browser narration echo discriminator', () => {
  it('leaves microphone PCM unchanged when no exact playback reference exists', () => {
    const discriminator = new BrowserNarrationEchoDiscriminator();
    const input = pcm(signal(CHUNK_SAMPLES, 1));

    const result = discriminator.process(input, 0.1);

    expect(result).toMatchObject({ state: 'unavailable', referenceActive: false, speechDiscriminated: false });
    expect(result.speechPcm).toEqual(input);
    expect(result.speechPcm).not.toBe(input);
  });

  it.each([
    { delayMs: 0, gain: 0.2 },
    { delayMs: 80, gain: 0.55 },
    { delayMs: 240, gain: 1 },
    { delayMs: 480, gain: 0.4 },
  ])('rejects exact echo at $delayMs ms and gain $gain', ({ delayMs, gain }) => {
    const reference = signal(SAMPLE_RATE * 2, 2);
    const microphone = delayedMix(reference, undefined, (delayMs * SAMPLE_RATE) / 1_000, gain);
    const discriminator = new BrowserNarrationEchoDiscriminator();
    discriminator.beginPlayback('playback', reference, 0);

    const results = processAll(discriminator, microphone);
    const settled = results.slice(-5);

    expect(settled.every((result) => result.referenceActive)).toBe(true);
    expect(settled.some((result) => result.state === 'echo')).toBe(true);
    expect(settled.some((result) => result.speechDiscriminated)).toBe(false);
  });

  it('reacquires echo after ducking gain and acoustic delay change', () => {
    const reference = signal(SAMPLE_RATE * 3, 22);
    const microphone = new Float32Array(reference.length);
    for (let index = 0; index < microphone.length; index += 1) {
      const firstPhase = index < SAMPLE_RATE * 1.5;
      const delay = firstPhase ? SAMPLE_RATE * 0.08 : SAMPLE_RATE * 0.14;
      const gain = firstPhase ? 0.35 : 0.8;
      microphone[index] = gain * (reference[index - delay] ?? 0);
    }
    const discriminator = new BrowserNarrationEchoDiscriminator();
    discriminator.beginPlayback('playback', reference, 0);

    const results = processAll(discriminator, microphone);

    expect(results.slice(10, 15).some((result) => result.state === 'echo')).toBe(true);
    expect(results.slice(-5).some((result) => result.state === 'echo')).toBe(true);
    expect(results.slice(-5).some((result) => result.speechDiscriminated)).toBe(false);
  });
  it('preserves independent near-end speech during an active reference', () => {
    const reference = signal(SAMPLE_RATE * 2, 3);
    const nearEnd = signal(SAMPLE_RATE * 2, 99);
    const discriminator = new BrowserNarrationEchoDiscriminator();
    discriminator.beginPlayback('playback', reference, 0);

    const results = processAll(discriminator, nearEnd);

    expect(results.slice(-5).some((result) => result.state === 'near-end' && result.speechDiscriminated)).toBe(true);
  });

  it('subtracts a correlated component while preserving mixed near-end speech', () => {
    const reference = signal(SAMPLE_RATE * 2, 4);
    const nearEndSource = signal(SAMPLE_RATE * 2, 41);
    const nearEnd = Float32Array.from(nearEndSource, (sample) => sample * 0.65);
    const microphone = delayedMix(reference, nearEnd, SAMPLE_RATE / 10, 0.65);
    const discriminator = new BrowserNarrationEchoDiscriminator();
    discriminator.beginPlayback('playback', reference, 0);

    const results = processAll(discriminator, microphone);
    const mixed = results.findLast((result) => result.state === 'mixed');

    expect(mixed).toBeDefined();
    expect(mixed?.speechDiscriminated).toBe(true);
    expect(mixed?.speechPcm.some((value) => value !== 0)).toBe(true);
  });

  it.each([
    {
      name: 'polarity-inverted echo',
      microphone: (reference: Float32Array) => Float32Array.from(reference, (sample) => -sample * 0.7),
    },
    {
      name: 'clipped echo',
      microphone: (reference: Float32Array) => Float32Array.from(reference, (sample) => sample * 4),
    },
    {
      name: 'nonlinear echo',
      microphone: (reference: Float32Array) =>
        Float32Array.from(reference, (sample) => Math.tanh(sample * 3) / Math.tanh(3)),
    },
  ])('fails closed for $name', ({ microphone }) => {
    const reference = signal(SAMPLE_RATE * 2, 42);
    const discriminator = new BrowserNarrationEchoDiscriminator();
    discriminator.beginPlayback('playback', reference, 0);

    const settled = processAll(discriminator, microphone(reference)).slice(-5);

    expect(settled.every((result) => result.referenceActive)).toBe(true);
    expect(settled.some((result) => result.speechDiscriminated)).toBe(false);
  });
  it('fails closed while there is too little history to align active narration', () => {
    const reference = signal(SAMPLE_RATE, 5);
    const discriminator = new BrowserNarrationEchoDiscriminator();
    discriminator.beginPlayback('playback', reference, 0);

    const result = discriminator.process(pcm(reference.slice(0, CHUNK_SAMPLES)), 0.1);

    expect(result).toMatchObject({ state: 'uncertain', referenceActive: true, speechDiscriminated: false });
    expect(result.speechPcm.every((value) => value === 0)).toBe(true);
  });

  it('retains only a bounded stopped reference for the echo tail and then becomes unavailable', () => {
    const reference = signal(SAMPLE_RATE * 4, 6);
    const discriminator = new BrowserNarrationEchoDiscriminator();
    discriminator.beginPlayback('playback', reference, 0);
    processAll(discriminator, reference.slice(0, SAMPLE_RATE));
    discriminator.endPlayback('playback', 1);

    const tail = discriminator.process(pcm(new Float32Array(CHUNK_SAMPLES)), 1.2);
    const expired = discriminator.process(pcm(new Float32Array(CHUNK_SAMPLES)), 1.91);

    expect(tail.referenceActive).toBe(true);
    expect(expired).toMatchObject({ state: 'unavailable', referenceActive: false });
  });

  it('bounds microphone and rendered-reference analysis history to two seconds', () => {
    const reference = signal(SAMPLE_RATE * 5, 8);
    const discriminator = new BrowserNarrationEchoDiscriminator();
    discriminator.beginPlayback('playback', reference, 0);
    processAll(discriminator, reference);

    const histories = discriminator as unknown as {
      microphoneHistory: Float32Array;
      referenceHistory: Float32Array;
    };
    expect(histories.microphoneHistory).toHaveLength(SAMPLE_RATE * 2);
    expect(histories.referenceHistory).toHaveLength(SAMPLE_RATE * 2);
  });
  it('clears reference and alignment state on reset', () => {
    const reference = signal(SAMPLE_RATE, 7);
    const discriminator = new BrowserNarrationEchoDiscriminator();
    discriminator.beginPlayback('playback', reference, 0);
    discriminator.reset();

    expect(discriminator.process(pcm(reference.slice(0, CHUNK_SAMPLES)), 0.1)).toMatchObject({
      state: 'unavailable',
      referenceActive: false,
    });
  });
});
