import { REMOTE_PUSH_KEY_ROUTE, REMOTE_PUSH_ROUTE } from '../../types/remoteAccess.ts';
import { sealedHttpSession } from './sealedSession.ts';

export type LivePushStatus = 'enabled' | 'disabled' | 'denied' | 'unsupported' | 'error';

function supported(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined' &&
    typeof ServiceWorkerRegistration.prototype.showNotification === 'function'
  );
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function sameKey(left: ArrayBuffer | null, right: Uint8Array<ArrayBuffer>): boolean {
  if (left === null) return false;
  const bytes = new Uint8Array(left);
  return bytes.length === right.length && bytes.every((value, index) => value === right[index]);
}

async function applicationServerKey(): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const response = await sealedHttpSession.fetch(REMOTE_PUSH_KEY_ROUTE, { cache: 'no-store' });
  if (!response.ok) return undefined;
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('publicKey' in body) || typeof body.publicKey !== 'string') {
    return undefined;
  }
  try {
    return base64UrlBytes(body.publicKey);
  } catch {
    return undefined;
  }
}

async function registerSubscription(
  registration: ServiceWorkerRegistration,
  applicationKey: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  let subscription = await registration.pushManager.getSubscription();
  if (subscription !== null && !sameKey(subscription.options.applicationServerKey, applicationKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationKey,
  });
  const response = await sealedHttpSession.fetch(REMOTE_PUSH_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (response.ok) return true;
  await subscription.unsubscribe();
  return false;
}

export async function livePushStatus(): Promise<LivePushStatus> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'disabled';
  try {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.pushManager.getSubscription()) === null ? 'disabled' : 'enabled';
  } catch {
    return 'error';
  }
}

/** Enables a browser-owned subscription, retained only in memory by the live host. */
export async function enableLivePush(): Promise<LivePushStatus> {
  if (!supported()) return 'unsupported';
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'disabled';
    const [registration, applicationKey] = await Promise.all([navigator.serviceWorker.ready, applicationServerKey()]);
    if (applicationKey === undefined) return 'error';
    return (await registerSubscription(registration, applicationKey)) ? 'enabled' : 'error';
  } catch {
    return 'error';
  }
}

export async function disableLivePush(): Promise<LivePushStatus> {
  if (!supported()) return 'unsupported';
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    const response = await sealedHttpSession.fetch(REMOTE_PUSH_ROUTE, { method: 'DELETE' });
    await subscription?.unsubscribe();
    return response.ok ? 'disabled' : 'error';
  } catch {
    return 'error';
  }
}

/** Re-registers a persisted browser subscription after the host process restarts. */
export async function restoreLivePushRegistration(): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing === null) return;
    const applicationKey = await applicationServerKey();
    if (applicationKey === undefined) return;
    await registerSubscription(registration, applicationKey);
  } catch {
    // Registration is opportunistic. The explicit settings action reports errors.
  }
}
