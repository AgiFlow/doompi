import { describe, expect, it } from 'vitest';
import { BrowserSpeechPresenceDetector } from '../web/browserSpeechPresenceDetector.ts';

class FakeWorker {
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: { message?: string }) => void) | null = null;
  public readonly messages: unknown[] = [];
  public terminated = false;

  public postMessage(message: unknown): void {
    this.messages.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public reply(index: number, result?: unknown, error?: string): void {
    const id = (this.messages[index] as { id: number }).id;
    this.onmessage?.({ data: { id, result, ...(error ? { error } : {}) } });
  }

  public crash(message: string): void {
    this.onerror?.({ message });
  }

  public malformed(data: unknown): void {
    this.onmessage?.({ data });
  }
}

function oneFrame(): Uint8Array {
  return new Uint8Array(512 * 2);
}

describe('browser speech-presence worker client', () => {
  it('surfaces worker initialization failure without an RMS fallback', async () => {
    const worker = new FakeWorker();
    const detector = new BrowserSpeechPresenceDetector(worker);
    const initialized = detector.initialize('/silero.onnx');
    await Promise.resolve();
    worker.reply(0, undefined, 'session failed');
    await expect(initialized).rejects.toThrow('session failed');
    expect(worker.messages).toHaveLength(1);
  });

  it('serializes inference and rejects stale responses across reset', async () => {
    const worker = new FakeWorker();
    const detector = new BrowserSpeechPresenceDetector(worker);
    const initialized = detector.initialize('/silero.onnx');
    await Promise.resolve();
    worker.reply(0, true);
    await initialized;

    const stale = detector.push(oneFrame());
    const reset = detector.reset();
    await Promise.resolve();
    expect(worker.messages).toHaveLength(2);
    worker.reply(1, [{ speech: true, sampleCount: 512 }]);
    await expect(stale).resolves.toEqual([]);
    await Promise.resolve();
    expect(worker.messages).toHaveLength(3);
    worker.reply(2, true);
    await reset;

    const current = detector.push(oneFrame());
    await Promise.resolve();
    worker.reply(3, [{ speech: false, sampleCount: 512 }]);
    await expect(current).resolves.toEqual([{ speech: false, sampleCount: 512 }]);
  });

  it('terminally rejects in-flight and queued work when the worker fails', async () => {
    const worker = new FakeWorker();
    const detector = new BrowserSpeechPresenceDetector(worker);
    const initialized = detector.initialize('/silero.onnx');
    await Promise.resolve();
    worker.reply(0, true);
    await initialized;

    const push = detector.push(oneFrame());
    const reset = detector.reset();
    await Promise.resolve();
    worker.crash('worker crashed');

    await expect(push).rejects.toThrow('worker crashed');
    await expect(reset).rejects.toThrow('worker crashed');
    await expect(detector.push(oneFrame())).rejects.toThrow('worker crashed');
    await expect(detector.close()).resolves.toBeUndefined();
    expect(worker.terminated).toBe(true);
  });

  it('treats malformed replies as terminal failures', async () => {
    const worker = new FakeWorker();
    const detector = new BrowserSpeechPresenceDetector(worker);
    const initialized = detector.initialize('/silero.onnx');
    await Promise.resolve();
    worker.malformed({ nope: true });

    await expect(initialized).rejects.toThrow('malformed response');
    expect(worker.terminated).toBe(true);
  });
});
