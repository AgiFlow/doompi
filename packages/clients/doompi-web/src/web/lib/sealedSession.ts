import { REMOTE_API_ROUTE } from '../../types/remoteAccess.ts';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

/**
 * The page's one sealed channel, shared with every installed plugin.
 *
 * Re-exported from the security package rather than created here, because the
 * cockpit and the plugins are bundled into the same page and all of them must
 * share one pair of nonce counters. A second instance would start its counter
 * at zero and the receiver would reject everything it sent as a replay.
 */
export const sealedSession = sealedTransport;

/** Stored by the pairing page so a reload can re-establish without another scan. */
const HOST_KEY_STORAGE = 'doompi.channelKey';

export function rememberHostChannelKey(hostPublicKey: string): void {
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
export async function restoreSealedSession(): Promise<boolean> {
  const hostKey = rememberedHostChannelKey();
  if (hostKey === undefined) return false;
  const clientPublicKey = await sealedSession.connect(hostKey);
  if (clientPublicKey === undefined) return false;
  // Deliberately an unsealed request: this is what establishes sealing. It
  // carries only a public key, which the relay may see and cannot use.
  try {
    const response = await fetch(`${REMOTE_API_ROUTE}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ clientPublicKey }),
    });
    if (response.ok) return true;
  } catch {
    // The hub is unreachable; the socket's own retry reports that.
  }
  // The host never completed its half, so sealing here would produce messages
  // nobody can open. Falling back to plaintext beats a silent blackout.
  sealedSession.reset();
  return false;
}
