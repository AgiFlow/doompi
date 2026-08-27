import { REMOTE_API_ROUTE, type RemoteAccessSettings } from '../types/remoteAccess.ts';

/**
 * Telling the cockpit that took over what it took over.
 *
 * The container has its own home volume, so it starts from its own settings and
 * knows nothing about the toggle that was just flipped on the host. Two calls
 * over the hub's own control plane close that gap: adopt the settings, then
 * turn remote access on, which is what the user asked for in the first place.
 *
 * Both routes are local-only, and a request to the published loopback port
 * arrives on the container's main listener, which is local by definition. The
 * tunnel listener is a different socket and is not reachable from here.
 */

const OK = 200;
const ACCEPTED = 202;
const LOOPBACK = '127.0.0.1';
/** Enabling starts a tunnel, which waits on cloudflared reaching the edge. */
const HANDOFF_TIMEOUT_MS = 60_000;

export interface CockpitHandoffOptions {
  port: number;
  host?: string;
  settings: RemoteAccessSettings;
  onNotice?: (message: string) => void;
  /** Test seam, so a suite never opens a socket. */
  send?: (url: string, method: string, body: string) => Promise<{ status: number; text: string }>;
}

async function sendJson(url: string, method: string, body: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
  });
  return { status: response.status, text: await response.text() };
}

export async function handOffRemoteAccess(options: CockpitHandoffOptions): Promise<boolean> {
  const notice = options.onNotice ?? ((): void => {});
  const send = options.send ?? sendJson;
  const base = `http://${options.host ?? LOOPBACK}:${String(options.port)}${REMOTE_API_ROUTE}`;
  try {
    // Sent whole, sandbox flag included: the contained hub reads its own
    // environment to know it is already contained, so the setting stays true
    // and the dialog keeps telling the truth about how it is running.
    const stored = await send(`${base}/settings`, 'PUT', JSON.stringify(options.settings));
    if (stored.status !== OK) {
      notice(`the container would not take the remote-access settings: ${stored.text}`);
      return false;
    }
    const enabled = await send(`${base}/enable`, 'POST', '{}');
    if (enabled.status !== OK && enabled.status !== ACCEPTED) {
      notice(`the container could not turn remote access on: ${enabled.text}`);
      return false;
    }
    return true;
  } catch (error) {
    // Reported rather than retried: the host is no longer serving, so the user
    // needs to know the tunnel is not up rather than watch a silent loop.
    notice(`the container could not turn remote access on: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
