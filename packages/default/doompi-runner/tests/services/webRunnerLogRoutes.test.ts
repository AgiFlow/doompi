import { describe, expect, it } from 'vitest';
import { createRunnerLogApi } from '../../src/adapters/runnerLogApi.ts';
import {
  RUNNER_API_BASE_PATH,
  runnerLogPath,
  runnerLogStreamUrl,
  runnerLogUrl,
  SESSION_QUERY_PARAM,
} from '../../src/types/webRunnerLog.ts';

/**
 * The page builds absolute URLs against the hub and the session server mounts
 * the app under a prefix it strips, so the two halves agree only as long as the
 * client's URL, minus the mount and the routing parameter, is a route the app
 * declares. These pin that seam.
 */
describe('the runner log route contract', () => {
  it('builds a client URL that is the mount, the route, and the session to proxy to', () => {
    expect(runnerLogUrl('s1', 'r1')).toBe(
      `/api/plugin/${RUNNER_API_BASE_PATH}${runnerLogPath('r1')}?${SESSION_QUERY_PARAM}=s1`,
    );
    expect(runnerLogPath('r1')).toBe('/runners/r1/log');
  });

  it('escapes ids so an odd name cannot reshape the path', () => {
    expect(runnerLogPath('c d')).toBe('/runners/c%20d/log');
    expect(runnerLogUrl('a/b', 'r1')).toContain(`${SESSION_QUERY_PARAM}=a%2Fb`);
  });

  it('folds the search parameters into the one query the URL already carries', () => {
    const url = runnerLogUrl('s1', 'r1', { grep: 'needle', ignoreCase: true, contextLines: 2, lines: 50 });
    // One '?' and one session parameter: the caller never appends its own.
    expect(url.match(/\?/gu)).toHaveLength(1);
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(Object.fromEntries(query)).toEqual({
      session: 's1',
      grep: 'needle',
      ignoreCase: 'true',
      contextLines: '2',
      lines: '50',
    });
  });

  it('leaves an unset parameter out rather than sending an empty one', () => {
    expect(runnerLogUrl('s1', 'r1', { grep: '' })).toBe(`/api/plugin/runner${runnerLogPath('r1')}?session=s1`);
  });

  it('names the offset the stream resumes from, beside the session', () => {
    expect(runnerLogStreamUrl('s1', 'r1', 512)).toBe(
      `/api/plugin/${RUNNER_API_BASE_PATH}/runners/r1/log/stream?${SESSION_QUERY_PARAM}=s1&from=512`,
    );
  });

  it('answers on exactly the path the client asks for, once the mount is stripped', async () => {
    const app = createRunnerLogApi({ storeDir: '/nonexistent-store', sessionId: 's1' });
    // A 404 carrying our own body is the route matching and finding no such
    // runner; a route that never matched would answer Hono's bare 404.
    for (const path of [runnerLogPath('r1'), `${runnerLogPath('r1')}/stream`]) {
      const response = await app.fetch(new Request(`http://session${path}`));
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ error: "No runner 'r1' in this session." });
    }
  });
});
