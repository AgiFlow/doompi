import * as ort from 'onnxruntime-web/wasm';
import { SileroVadFrames } from './sileroVadFrames.ts';

type WorkerCommand =
  | { id: number; type: 'initialize'; modelUrl: string }
  | { id: number; type: 'push'; pcm: ArrayBuffer }
  | { id: number; type: 'reset' };

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let session: ort.InferenceSession | undefined;
let frames: SileroVadFrames | undefined;

function respond(id: number, result: unknown): void {
  globalThis.postMessage({ id, result });
}

function fail(id: number, error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  globalThis.postMessage({ id, error: message });
}

globalThis.addEventListener('message', (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  void (async () => {
    try {
      if (command.type === 'initialize') {
        session = await ort.InferenceSession.create(command.modelUrl, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
        frames = new SileroVadFrames(async (input, state) => {
          if (session === undefined) throw new Error('Silero session is not initialized.');
          const output = await session.run({
            input: new ort.Tensor('float32', input, [1, input.length]),
            state: new ort.Tensor('float32', state, [2, 1, 128]),
            sr: new ort.Tensor('int64', BigInt64Array.of(16_000n), []),
          });
          const probability = Number(output.output?.data[0]);
          const stateOutput = output.stateN;
          if (stateOutput === undefined || !(stateOutput.data instanceof Float32Array))
            throw new Error('Silero model did not return recurrent state.');
          return { probability, state: stateOutput.data };
        });
        respond(command.id, true);
        return;
      }
      if (frames === undefined) throw new Error('Silero worker is not initialized.');
      if (command.type === 'reset') {
        frames.reset();
        respond(command.id, true);
        return;
      }
      respond(command.id, await frames.push(new Uint8Array(command.pcm)));
    } catch (error) {
      fail(command.id, error);
    }
  })();
});
