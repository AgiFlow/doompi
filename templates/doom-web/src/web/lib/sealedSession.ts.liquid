import { REMOTE_CHANNEL_ROUTE, REMOTE_HTTP_ROUTE, type RemoteChannelScope } from '../../types/remoteAccess.ts';
import { createSealedTransport, sealedTransport } from '@agimon-ai/doompi-web-security/browser';

/** Each concurrent transport owns independent nonce counters and a purpose-bound server channel. */
export const sealedSession = createSealedTransport();
export const sealedProtocolSession = createSealedTransport();
/** Plugins import this singleton directly, so it remains the HTTP channel. */
export const sealedHttpSession = sealedTransport;
sealedHttpSession.relayRequestsThrough(REMOTE_HTTP_ROUTE);

const SCOPED_TRANSPORTS = [
  ['session', sealedSession],
  ['protocol', sealedProtocolSession],
  ['http', sealedHttpSession],
] as const;

/** Stored after QR pairing or passkey sign-in so this tab can re-establish the ephemeral channel. */
const HOST_KEY_STORAGE = 'doompi.channelKey';

let restoration: Promise<boolean> | undefined;
export function rememberHostChannelKey(hostPublicKey: string): void {
  restoration = undefined;
  try {
    window.sessionStorage.setItem(HOST_KEY_STORAGE, hostPublicKey);
  } catch {
    // Storage denied; the channel lasts this page load only.
  }
}

export function rememberedHostChannelKey(): string | undefined {
  try {
    return window.sessionStorage.getItem(HOST_KEY_STORAGE) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-establishes the channel on load, if this device has a host key to use.
 *
 * Session storage rather than local: the channel is ephemeral by design, and a
 * key that outlived the tab would suggest a channel that no longer exists.
 */
async function establishSealedSession(): Promise<boolean> {
  const hostKey = rememberedHostChannelKey();
  if (hostKey === undefined) return false;

  for (const [scope, transport] of SCOPED_TRANSPORTS) {
    const clientPublicKey = await transport.connect(hostKey);
    if (clientPublicKey === undefined || !(await registerChannel(scope, clientPublicKey))) {
      resetSealedSessions();
      return false;
    }
  }
  return true;
}

export function restoreSealedSession(): Promise<boolean> {
  restoration ??= establishSealedSession();
  return restoration;
}

export function resetSealedSessions(): void {
  for (const [, transport] of SCOPED_TRANSPORTS) transport.reset();
  restoration = undefined;
}

async function registerChannel(scope: RemoteChannelScope, clientPublicKey: string): Promise<boolean> {
  try {
    const response = await fetch(REMOTE_CHANNEL_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ scope, clientPublicKey }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
