import net from 'node:net';
import { OAUTH_CALLBACK_PORTS } from '../services/oauthCallback.ts';

const LOOPBACK = '127.0.0.1';

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, LOOPBACK, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Reports which OAuth callback ports this launch may publish.
 *
 * A taken port means another sandbox already holds it, so publishing would
 * fail the whole launch over a login the session may never attempt. Skipping
 * it costs only the ability to log in from inside this particular container.
 */
export async function availableLoginPorts(ports: readonly number[] = OAUTH_CALLBACK_PORTS): Promise<number[]> {
  const free: number[] = [];
  for (const port of ports) {
    if (await portIsFree(port)) free.push(port);
  }
  return free;
}
