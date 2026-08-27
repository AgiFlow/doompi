import type { MigratingSession } from '../types/remoteAccess.ts';

/**
 * Recreates sessions in the cockpit that took over.
 *
 * Over the hub's own HTTP API rather than anything private, because the two
 * hubs are separate processes in separate namespaces and this is the only
 * surface they share. The container publishes on loopback, so the address is
 * the same one the browser is about to reconnect to.
 */

const CREATED = 201;
const LOOPBACK = '127.0.0.1';
/** Long enough for a cold agent start, short enough that a wedged hub is not mistaken for a slow one. */
const RELAUNCH_TIMEOUT_MS = 30_000;

export interface SessionRelaunchOptions {
  port: number;
  /** Which address the hub answers on; loopback, because the container publishes there. */
  host?: string;
  sessions: readonly MigratingSession[];
  onNotice?: (message: string) => void;
  /** Test seam, so a suite never opens a socket. */
  post?: (url: string, body: string) => Promise<{ status: number; text: string }>;
}

async function postJson(url: string, body: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(RELAUNCH_TIMEOUT_MS),
  });
  return { status: response.status, text: await response.text() };
}

/**
 * Asks the new cockpit for each session, one at a time.
 *
 * Sequential rather than concurrent: a session spawn starts an agent process,
 * and firing several at a cold container turns one slow start into several
 * competing ones. There is no hurry here, and the notices read in order.
 */
export async function relaunchSessions(options: SessionRelaunchOptions): Promise<number> {
  const notice = options.onNotice ?? ((): void => {});
  const post = options.post ?? postJson;
  const url = `http://${options.host ?? LOOPBACK}:${String(options.port)}/api/sessions`;
  let recreated = 0;
  for (const session of options.sessions) {
    const label = session.name ?? session.cwd;
    try {
      const body = JSON.stringify({ cwd: session.cwd, ...(session.name === undefined ? {} : { name: session.name }) });
      const answer = await post(url, body);
      if (answer.status === CREATED) {
        recreated += 1;
        notice(`recreated ${label} in the container`);
      } else {
        // Reported rather than retried: the host copy is already stopped, so a
        // silent failure would look like the session simply vanished.
        notice(`could not recreate ${label} in the container: ${answer.text}`);
      }
    } catch (error) {
      notice(`could not recreate ${label} in the container: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return recreated;
}
