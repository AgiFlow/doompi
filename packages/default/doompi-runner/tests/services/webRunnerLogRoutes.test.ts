import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeEach as beforeEachApiRoutes } from 'vitest';
beforeEachApiRoutes(() => bindSessionApiWorkspace(() => 'test-workspace'));
import { describe, expect, it } from 'vitest';

import { api } from '../../generated/client';
import { RUN_ID_PARAM } from '../../src/constants/webRunnerLog';
import { createRunnerLogApi } from '../../src/services/runnerLogApi';

/**
 * The page addresses the hub through the generated client and the session
 * server mounts the app under a prefix it strips, so the two halves agree only
 * as long as the client's URL, minus that mount, is a route the app declares.
 * Both now read the same table, and this is what proves the table is wired to
 * a handler on each side rather than merely shared.
 */

const SESSION = 's1';
const MOUNT = `/api/workspaces/test-workspace/sessions/${SESSION}/plugins/runner`;

/** Every route this package serves, addressed exactly as the cockpit addresses it. */
function requests(): { path: string; method: string }[] {
  const client = api.session(SESSION);
  const run = { params: { [RUN_ID_PARAM]: 'r1' } };
  return [
    { path: client.log.url(run), method: 'GET' },
    { path: client.logStream.url({ ...run, query: { from: 0 } }), method: 'GET' },
    { path: client.screenStream.url({ ...run, query: { from: 0 } }), method: 'GET' },
    { path: client.input.url(run), method: 'POST' },
  ];
}

describe('the runner log route contract', () => {
  it('answers on exactly the path the client asks for, once the mount is stripped', async () => {
    const app = createRunnerLogApi({ storeDir: '/nonexistent-store', sessionId: SESSION });

    for (const { path, method } of requests()) {
      expect(path.startsWith(`${MOUNT}/`), path).toBe(true);
      const below = path.slice(MOUNT.length);
      const response = await app.fetch(new Request(`http://session${below}`, { method }));

      // A 404 carrying our own JSON body is the route matching and finding no
      // such runner; a route that never matched answers Hono's bare 404 text.
      // No stream is ever opened: both stream routes refuse an unknown run
      // before streamSSE is reached, so nothing here waits on a socket.
      expect(response.status, below).toBe(404);
      expect(await response.json(), below).toEqual({ error: expect.any(String) });
    }
  });
});
