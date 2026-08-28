import { describe, expect, it } from 'vitest';
import { VOICE_MEDIA_SAMPLE_RATE } from '../src/exports/clientMedia.ts';
import {
  ClientCaptureActivityLifecycle,
  calculateClientPcmDbfs,
  type SpeechPresenceWindow,
} from '../src/types/clientCaptureActivity.ts';

function pcmChunk(amplitude: number, durationMs = 32): Uint8Array {
  const pcm = new Uint8Array((VOICE_MEDIA_SAMPLE_RATE * durationMs * 2) / 1_000);
  const view = new DataView(pcm.buffer);
  for (let offset = 0; offset < pcm.byteLength; offset += 2) view.setInt16(offset, amplitude, true);
  return pcm;
}

function windows(...speech: boolean[]): SpeechPresenceWindow[] {
  return speech.map((present) => ({ speech: present, sampleCount: 512 }));
}

describe('portable client capture activity', () => {
  it('calculates PCM16 energy without Buffer or Web Audio values', () => {
    expect(calculateClientPcmDbfs(pcmChunk(0))).toBe(-120);
    expect(calculateClientPcmDbfs(pcmChunk(16_384))).toBeCloseTo(-6.02, 1);
    expect(calculateClientPcmDbfs(pcmChunk(-16_384))).toBeCloseTo(-6.02, 1);
  });

  it('requires four classifier-positive windows to confirm speech', () => {
    const lifecycle = new ClientCaptureActivityLifecycle();
    expect(lifecycle.push(pcmChunk(8_000), windows(true, true, true)).state).toBe('listening');
    expect(lifecycle.push(pcmChunk(0), windows(true)).state).toBe('speech');
  });

  it('uses classified sample duration across mixed native window sizes', () => {
    const lifecycle = new ClientCaptureActivityLifecycle();
    expect(lifecycle.push(pcmChunk(0), [{ speech: true, sampleCount: 640 }]).state).toBe('listening');
    expect(lifecycle.push(pcmChunk(0), [{ speech: true, sampleCount: 256 }]).state).toBe('listening');
    expect(lifecycle.push(pcmChunk(0), [{ speech: true, sampleCount: 1_024 }]).state).toBe('speech');
  });

  it('never treats ambient RMS or isolated energy spikes as authoritative speech', () => {
    const lifecycle = new ClientCaptureActivityLifecycle();
    const ambientAtMinus41Dbfs = pcmChunk(292, 100);
    for (let index = 0; index < 20; index += 1) {
      expect(lifecycle.push(index % 2 === 0 ? pcmChunk(4_000, 100) : ambientAtMinus41Dbfs).state).toBe('listening');
    }
  });

  it('does not let isolated classifier spikes postpone an endpoint', () => {
    const lifecycle = new ClientCaptureActivityLifecycle(600);
    lifecycle.push(pcmChunk(2_000), windows(true, true, true, true));
    expect(
      lifecycle.push(pcmChunk(0), windows(...Array.from({ length: 18 }, (_, index) => index % 3 === 0))).state,
    ).toBe('speech');
    expect(lifecycle.push(pcmChunk(0), windows(false)).state).toBe('endpoint');
  });

  it('keeps RMS as level and elapsed-time telemetry', () => {
    const lifecycle = new ClientCaptureActivityLifecycle();
    expect(lifecycle.push(pcmChunk(16_384, 100))).toMatchObject({ state: 'listening', elapsedMs: 100, levelDbfs: -6 });
  });

  it('rejects invalid PCM, windows, and endpoint configuration', () => {
    expect(() => new ClientCaptureActivityLifecycle(249)).toThrow(/at least 250 ms/u);
    expect(() => new ClientCaptureActivityLifecycle(250.5)).toThrow(/integer/u);
    expect(() => calculateClientPcmDbfs(new Uint8Array())).toThrow(/complete 16-bit samples/u);
    expect(() => calculateClientPcmDbfs(new Uint8Array([1]))).toThrow(/complete 16-bit samples/u);
    expect(() => new ClientCaptureActivityLifecycle().push(pcmChunk(0), [{ speech: false, sampleCount: 0 }])).toThrow(
      /positive integer/u,
    );
  });
});
