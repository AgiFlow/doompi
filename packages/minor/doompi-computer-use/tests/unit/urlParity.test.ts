import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeAll, describe, expect, it } from 'vitest';

import { api } from '../../generated/client';
import routes from '../../src/types/apiRoutes';
import { COMPUTER_USE_ROUTES } from '../../src/types/computerUseApi';

/**
 * Pins the URL the panel sends, as a literal string.
 *
 * It was captured from the hand-written `activationUrl` before that builder was
 * deleted, so it is the shape the cockpit has always sent rather than the shape
 * the current code happens to produce. A mistyped mount is not reported by the
 * route it misses: the service worker answers any unrecognised path out of the
 * signed bundle cache.
 *
 * One difference from the old builder is deliberate. `?session=` is gone; the
 * session is already a path segment, the broker never read the parameter, and
 * no contract declared it.
 */

const SESSION = 's1';

beforeAll(() => {
  bindSessionApiWorkspace(() => 'test-workspace');
});

const MOUNT = '/api/workspaces/test-workspace/sessions/s1';

describe('the URLs this package sends', () => {
  it('requests a confirmed activation', () => {
    expect(api.session(SESSION).activate.url()).toBe(`${MOUNT}/plugins/computer-use/activate`);
    expect(api.session(SESSION).activate.spec.method).toBe('POST');
  });

  it('sends no session parameter, which the broker never read', () => {
    expect(api.session(SESSION).activate.url()).not.toContain('session=');
  });

  it('stays root-relative, which is the only form the sealed relay forwards', () => {
    const url = api.session(SESSION).activate.url();
    expect(url.startsWith('/api/')).toBe(true);
    expect(url.startsWith('//')).toBe(false);
  });

  it('declares every broker path once, from the table the dispatcher reads', () => {
    expect(Object.fromEntries(Object.entries(routes).map(([name, spec]) => [name, spec.path]))).toEqual(
      COMPUTER_USE_ROUTES,
    );
  });
});
