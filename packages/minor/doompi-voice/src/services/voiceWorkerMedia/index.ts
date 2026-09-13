import type { MessagePort } from 'node:worker_threads';

import type { IVoiceMediaHostConnection } from '../../types';

type CaptureHost = Pick<IVoiceMediaHostConnection, 'startCapture' | 'readCapture' | 'stopCapture' | 'abortCapture'>;
type MediaCall = { id: number; method: keyof CaptureHost; args: unknown[] };

/** A dedicated worker port carries capture data, separate from the audio-free worker control protocol. */
export function serveVoiceWorkerMedia(port: MessagePort, host: IVoiceMediaHostConnection): () => void {
  const captures = new Set<string>();
  let closed = false;
  port.on('message', (call: MediaCall) => {
    if (closed || !Number.isSafeInteger(call?.id) || !Array.isArray(call.args)) return;
    const run = async (): Promise<unknown> => {
      const id = call.args[0];
      if (typeof id !== 'string') throw new Error('Invalid worker capture id.');
      if (call.method === 'startCapture') {
        captures.add(id);
        await host.startCapture(id, call.args[1] as Parameters<CaptureHost['startCapture']>[1]);
        if (closed) await host.abortCapture(id);
        return undefined;
      }
      if (!captures.has(id)) throw new Error('Worker does not own this capture.');
      if (call.method === 'readCapture') {
        const result = await host.readCapture(id);
        if (result.state === 'stopped') captures.delete(id);
        return result;
      }
      if (call.method === 'stopCapture') return host.stopCapture(id);
      if (call.method === 'abortCapture') {
        await host.abortCapture(id);
        captures.delete(id);
        return undefined;
      }
      throw new Error('Invalid worker media operation.');
    };
    void run().then(
      (value) => {
        if (!closed) port.postMessage({ id: call.id, value });
      },
      (error: unknown) => {
        if (!closed) port.postMessage({ id: call.id, error: error instanceof Error ? error.message : String(error) });
      },
    );
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const id of captures) void host.abortCapture(id).catch(() => undefined);
    captures.clear();
    port.close();
  };
  port.once('close', close);
  return close;
}

export function connectVoiceWorkerMedia(port: MessagePort): IVoiceMediaHostConnection {
  let sequence = 0;
  let closed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  port.on('message', (response: { id: number; value?: unknown; error?: string }) => {
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error));
    else request.resolve(response.value);
  });
  port.once('close', () => {
    closed = true;
    for (const request of pending.values()) request.reject(new Error('Worker media transport closed.'));
    pending.clear();
  });
  const call = <T>(method: keyof CaptureHost, ...args: unknown[]): Promise<T> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('Worker media transport closed.'));
        return;
      }
      const id = ++sequence;
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      port.postMessage({ id, method, args });
    });
  const noPlayback = async (): Promise<never> => {
    throw new Error('Playback belongs to the session host.');
  };
  return {
    startCapture: (id, config) => call('startCapture', id, config),
    readCapture: async (id) => {
      const result = await call<Awaited<ReturnType<CaptureHost['readCapture']>>>('readCapture', id);
      return { ...result, pcm: Buffer.from(result.pcm) };
    },
    stopCapture: (id) => call('stopCapture', id),
    abortCapture: (id) => call('abortCapture', id),
    startPlayback: noPlayback,
    readPlayback: noPlayback,
    stopPlayback: noPlayback,
    abortPlayback: noPlayback,
  };
}
