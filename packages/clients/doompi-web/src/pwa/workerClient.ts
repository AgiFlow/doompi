import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

import type { SessionWebComposition } from '../types/hub';

export interface BundleActivationRequest {
  publicKey: string;
  minimumRevision: number;
}

export type WorkerResult = { ok: true; revision?: number } | { ok: false; code: string; message: string };

const PLUGIN_FETCH_MESSAGE = 'doompi:plugin-fetch';
const PLUGIN_FETCH_RESULT_MESSAGE = 'doompi:plugin-fetch-result';

interface PluginFetchRequest {
  type: typeof PLUGIN_FETCH_MESSAGE;
  requestId: number;
  path: string;
}

function parsePluginFetchRequest(value: unknown): PluginFetchRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const request = value as Partial<PluginFetchRequest>;
  if (
    request.type !== PLUGIN_FETCH_MESSAGE ||
    !Number.isSafeInteger(request.requestId) ||
    typeof request.path !== 'string' ||
    !request.path.startsWith('/api/web-plugins/')
  ) {
    return undefined;
  }
  return request as PluginFetchRequest;
}

async function answerPluginFetch(port: MessagePort, request: PluginFetchRequest): Promise<void> {
  try {
    const response = await sealedTransport.fetch(request.path, { cache: 'no-store', credentials: 'include' });
    const body = await response.arrayBuffer();
    port.postMessage(
      {
        type: PLUGIN_FETCH_RESULT_MESSAGE,
        requestId: request.requestId,
        ok: true,
        status: response.status,
        headers: [...response.headers.entries()],
        body,
      },
      [body],
    );
  } catch (error) {
    port.postMessage({
      type: PLUGIN_FETCH_RESULT_MESSAGE,
      requestId: request.requestId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function isWorkerResult(value: unknown): value is WorkerResult {
  if (typeof value !== 'object' || value === null || !('ok' in value) || typeof value.ok !== 'boolean') return false;
  if (value.ok) return !('revision' in value) || typeof value.revision === 'number';
  return 'code' in value && typeof value.code === 'string' && 'message' in value && typeof value.message === 'string';
}

async function activeWorker(): Promise<ServiceWorker> {
  if (!('serviceWorker' in navigator)) throw new Error('The trusted service worker is unavailable.');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('The trusted service worker is not ready.')), 10_000);
    }),
  ]).finally(() => clearTimeout(timeout));
  const serviceWorker = registration.active ?? registration.waiting ?? registration.installing;
  if (serviceWorker === null) throw new Error('The trusted service worker is unavailable.');
  return serviceWorker;
}

async function requestWorker(message: object): Promise<WorkerResult> {
  const serviceWorker = await activeWorker();
  const channel = new MessageChannel();
  return await new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      resolve({ ok: false, code: 'worker-timeout', message: 'The trusted service worker did not answer.' });
    }, 120_000);
    channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
      const isPluginFetch =
        typeof event.data === 'object' &&
        event.data !== null &&
        (event.data as { type?: unknown }).type === PLUGIN_FETCH_MESSAGE;
      if (isPluginFetch) {
        const pluginFetch = parsePluginFetchRequest(event.data);
        if (pluginFetch !== undefined) {
          void answerPluginFetch(channel.port1, pluginFetch);
        } else {
          const requestId = (event.data as { requestId?: unknown }).requestId;
          channel.port1.postMessage({
            type: PLUGIN_FETCH_RESULT_MESSAGE,
            requestId: Number.isSafeInteger(requestId) ? requestId : -1,
            ok: false,
            message: 'The trusted service worker requested an invalid plugin path.',
          });
        }
        return;
      }
      window.clearTimeout(timeout);
      channel.port1.close();
      resolve(
        isWorkerResult(event.data)
          ? event.data
          : {
              ok: false,
              code: 'invalid-worker-response',
              message: 'The trusted service worker returned invalid data.',
            },
      );
    });
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
    relayThroughClient: sealedTransport.active(),
  });
}

export async function refreshVerifiedBundle(): Promise<WorkerResult> {
  return await requestWorker({ type: 'doompi:refresh-bundle' });
}

export async function resetBundleTrust(): Promise<WorkerResult> {
  return await requestWorker({ type: 'doompi:reset-bundle-trust' });
}
