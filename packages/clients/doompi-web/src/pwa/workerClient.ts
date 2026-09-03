import type { SessionWebComposition } from '../types/hub.ts';

export interface BundleActivationRequest {
  publicKey: string;
  minimumRevision: number;
}

export type WorkerResult = { ok: true; revision?: number } | { ok: false; code: string; message: string };

function isWorkerResult(value: unknown): value is WorkerResult {
  if (typeof value !== 'object' || value === null || !('ok' in value) || typeof value.ok !== 'boolean') return false;
  if (value.ok) return !('revision' in value) || typeof value.revision === 'number';
  return 'code' in value && typeof value.code === 'string' && 'message' in value && typeof value.message === 'string';
}

async function activeWorker(): Promise<ServiceWorker> {
  const registration = await navigator.serviceWorker.ready;
  const serviceWorker = registration.active ?? registration.waiting ?? registration.installing;
  if (serviceWorker === null) throw new Error('The trusted service worker is unavailable.');
  return serviceWorker;
}

async function requestWorker(message: object): Promise<WorkerResult> {
  const serviceWorker = await activeWorker();
  const channel = new MessageChannel();
  return await new Promise((resolve) => {
    const timeout = window.setTimeout(
      () => resolve({ ok: false, code: 'worker-timeout', message: 'The trusted service worker did not answer.' }),
      120_000,
    );
    channel.port1.addEventListener(
      'message',
      (event: MessageEvent<unknown>) => {
        window.clearTimeout(timeout);
        resolve(
          isWorkerResult(event.data)
            ? event.data
            : {
                ok: false,
                code: 'invalid-worker-response',
                message: 'The trusted service worker returned invalid data.',
              },
        );
      },
      { once: true },
    );
    channel.port1.start();
    serviceWorker.postMessage(message, [channel.port2]);
  });
}

export async function activateVerifiedBundle(request: BundleActivationRequest): Promise<WorkerResult> {
  return await requestWorker({ type: 'doompi:activate-bundle', ...request });
}

export async function activateVerifiedPluginComposition(composition: SessionWebComposition): Promise<WorkerResult> {
  return await requestWorker({
    type: 'doompi:activate-plugin-composition',
    compositionId: composition.id,
    revision: composition.revision,
    manifestUrl: composition.manifestUrl,
    rawAssetBaseUrl: composition.rawAssetBaseUrl,
    verifiedAssetBaseUrl: composition.verifiedAssetBaseUrl,
  });
}

export async function refreshVerifiedBundle(): Promise<WorkerResult> {
  return await requestWorker({ type: 'doompi:refresh-bundle' });
}

export async function resetBundleTrust(): Promise<WorkerResult> {
  return await requestWorker({ type: 'doompi:reset-bundle-trust' });
}
