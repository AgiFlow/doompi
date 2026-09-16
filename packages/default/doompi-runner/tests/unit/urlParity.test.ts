import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeAll, describe, expect, it } from 'vitest';

import { api } from '../../generated/client';
import { RUN_ID_PARAM } from '../../src/constants/webRunnerLog';
import { RUNNER_LOG_PARAMS } from '../../src/types/webRunnerLog';

/**
 * Pins every URL this package sends, as a literal string.
 *
 * These were captured from the four hand-written builders before they were
 * deleted. Keeping them literal is the point: a mistyped mount is not reported
 * by the route it misses, because the service worker answers any unrecognised
 * path out of the signed bundle cache.
 *
 * Two deliberate differences from the deleted builders, both recorded here
 * rather than left to be discovered:
 *
 * - The `?session=` parameter is gone. It addressed the hub's flat
 *   `/api/plugins/` proxy, which resolves a session from the query because its
 *   path cannot name one. Every URL here is the session-scoped mount, which
 *   names the session twice over in the path already, so the parameter was
 *   carried and then deleted by the hub before the request was forwarded.
 * - A space in `grep` is now `%20` rather than `+`. The builder used
 *   `URLSearchParams`; the client percent-encodes each pair. `URL.searchParams`
 *   on the route decodes both to the same space.
 */

const SESSION = 'session/a';
const RUN = 'run one';
const MOUNT = '/api/workspaces/test-workspace/sessions/session%2Fa/plugins/runner';
const RUNNER = `${MOUNT}/runners/run%20one`;

beforeAll(() => {
  bindSessionApiWorkspace(() => 'test-workspace');
});

/** The run id, as every route in this package carries it. */
const run = { params: { [RUN_ID_PARAM]: RUN } };

describe('the URLs this package sends', () => {
  it('reads one runner s log off that session s own mount', () => {
    expect(api.session(SESSION).log.url(run)).toBe(`${RUNNER}/log`);
  });

  it('asks a filtered read for exactly the parameters that were set', () => {
    const url = api.session(SESSION).log.url({
      ...run,
      query: { grep: 'a b', ignoreCase: true, contextLines: 2, lines: 50 },
    });

    expect(url).toBe(`${RUNNER}/log?grep=a%20b&ignoreCase=true&contextLines=2&lines=50`);
  });

  it('names the offset a stream resumes from, and nothing else', () => {
    expect(api.session(SESSION).logStream.url({ ...run, query: { [RUNNER_LOG_PARAMS.from]: 512 } })).toBe(
      `${RUNNER}/log/stream?from=512`,
    );
    expect(api.session(SESSION).screenStream.url({ ...run, query: { [RUNNER_LOG_PARAMS.from]: 0 } })).toBe(
      `${RUNNER}/screen/stream?from=0`,
    );
  });

  it('posts keystrokes to the pane beside that same screen', () => {
    expect(api.session(SESSION).input.url(run)).toBe(`${RUNNER}/screen/input`);
  });

  it('escapes a run id that would otherwise change the path', () => {
    const escaped = (runId: string): string => api.session(SESSION).log.url({ params: { [RUN_ID_PARAM]: runId } });

    expect(escaped('a b')).toBe(`${MOUNT}/runners/a%20b/log`);
    expect(escaped('../escape')).toBe(`${MOUNT}/runners/..%2Fescape/log`);
  });

  it('offers the two streams an address and no way to call them', () => {
    // A relayed call buffers the whole response before returning, so a stream
    // route that could be called would hang a remote session rather than fail.
    // The type stops an author; this is what stops a cast.
    expect(typeof api.session(SESSION).logStream).toBe('object');
    expect(typeof api.session(SESSION).screenStream).toBe('object');
    expect(typeof api.session(SESSION).log).toBe('function');
  });

  it('stays root-relative, which is the only form the sealed relay forwards', () => {
    const url = api.session(SESSION).log.url(run);

    expect(url.startsWith('/api/')).toBe(true);
    expect(url.startsWith('//')).toBe(false);
  });
});
