import { startQrScanner, type QrScannerSession } from './qrScanner.ts';
import { activateVerifiedBundle } from './workerClient.ts';

const PAIRING_PATH = '/pair';
const REQUIRED_FRAGMENT_FIELDS = ['c', 'k', 's', 'r'] as const;

interface PairingLink {
  code: string;
  channelPublicKey: string;
  signerPublicKey: string;
  minimumRevision: number;
  url: URL;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!(found instanceof HTMLElement)) throw new Error(`The PWA shell is missing #${id}.`);
  return found as T;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parsePairingLink(
  raw: string,
  expectedOrigin: string = window.location.origin,
): PairingLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.origin !== expectedOrigin || url.pathname !== PAIRING_PATH || url.search !== '') return undefined;

  const values = new URLSearchParams(url.hash.slice(1));
  if (REQUIRED_FRAGMENT_FIELDS.some((name) => values.get(name) === null)) return undefined;
  const code = values.get('c') ?? '';
  const channelPublicKey = values.get('k') ?? '';
  const signerPublicKey = values.get('s') ?? '';
  const minimumRevision = parsePositiveInteger(values.get('r') ?? '');
  if (!/^[A-Za-z0-9_-]{20,512}$/u.test(code)) return undefined;
  if (!/^[A-Za-z0-9_-]{40,512}$/u.test(channelPublicKey)) return undefined;
  if (!/^[A-Za-z0-9_-]{80,512}$/u.test(signerPublicKey)) return undefined;
  if (minimumRevision === undefined) return undefined;
  return { code, channelPublicKey, signerPublicKey, minimumRevision, url };
}

function unsupportedReason(): string | undefined {
  if (!('serviceWorker' in navigator)) return 'This browser does not support service workers.';
  if (!('crypto' in globalThis) || globalThis.crypto.subtle === undefined)
    return 'This browser does not support WebCrypto.';
  if (!('indexedDB' in globalThis)) return 'This browser does not support durable PWA state.';
  if (!('caches' in globalThis)) return 'This browser does not support verified application caches.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser does not support camera access.';
  return undefined;
}

async function registerWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  return registration;
}

function setStatus(message: string, tone: 'normal' | 'good' | 'bad' = 'normal'): void {
  const status = element<HTMLParagraphElement>('pwa-status');
  status.textContent = message;
  status.dataset.tone = tone;
}

async function start(): Promise<void> {
  const scan = element<HTMLButtonElement>('scan');
  const cancel = element<HTMLButtonElement>('cancel');
  const video = element<HTMLVideoElement>('camera');
  const unsupported = unsupportedReason();
  if (unsupported !== undefined) {
    scan.disabled = true;
    setStatus(unsupported, 'bad');
    return;
  }

  try {
    await registerWorker();
  } catch {
    scan.disabled = true;
    setStatus('The trusted service worker could not be installed.', 'bad');
    return;
  }

  window.addEventListener('doompi:activate-bundle', (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (
      typeof detail !== 'object' ||
      detail === null ||
      !('publicKey' in detail) ||
      typeof detail.publicKey !== 'string' ||
      !('minimumRevision' in detail) ||
      typeof detail.minimumRevision !== 'number'
    ) {
      return;
    }
    void activateVerifiedBundle({ publicKey: detail.publicKey, minimumRevision: detail.minimumRevision }).then(
      (result) => {
        window.dispatchEvent(new CustomEvent('doompi:bundle-activation-result', { detail: result }));
      },
    );
  });

  let scanner: QrScannerSession | undefined;
  const stopScanner = (): void => {
    scanner?.stop();
    scanner = undefined;
    video.hidden = true;
    cancel.hidden = true;
    scan.hidden = false;
  };

  scan.addEventListener('click', async () => {
    scan.hidden = true;
    cancel.hidden = false;
    video.hidden = false;
    setStatus('Point the camera at the QR code shown by DoomPi.');
    try {
      scanner = await startQrScanner(
        video,
        (value) => {
          const pairing = parsePairingLink(value);
          stopScanner();
          if (pairing === undefined) {
            setStatus('That QR code is not a pairing link for this DoomPi origin.', 'bad');
            return;
          }
          setStatus('Pairing link accepted. Opening secure setup.', 'good');
          window.location.assign(pairing.url.href);
        },
        () => {
          stopScanner();
          setStatus('The QR code could not be read. Try again.', 'bad');
        },
      );
    } catch (error) {
      stopScanner();
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      setStatus(denied ? 'Camera permission was not granted.' : 'The camera could not be started.', 'bad');
    }
  });

  cancel.addEventListener('click', () => {
    stopScanner();
    setStatus('Scanning cancelled.');
  });
  window.addEventListener('pagehide', stopScanner);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopScanner();
  });
  setStatus('Ready to scan the pairing QR code.');
}

void start();
