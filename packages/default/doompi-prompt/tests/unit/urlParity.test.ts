import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeAll, describe, expect, it } from 'vitest';

import { api } from '../../generated/client';

/**
 * Pins every URL this package sends, as a literal string.
 *
 * These were captured from the hand-written builders before they were deleted,
 * with both of their branches compared side by side, so they are the shapes the
 * cockpit has always sent rather than the shapes the current code happens to
 * produce. Keeping them literal is the point: a mistyped mount is not reported
 * by the route it misses, because the service worker answers any unrecognised
 * path out of the signed bundle cache.
 *
 * This package spelled `prompts` three times, once as `API_BASE_PATH` and twice
 * more inside the builder, and the builder also decided from a nullable session
 * id whether the call was global or session scoped. The mount is now the folder
 * the build reads, and the scope is which accessor the page asks for; both
 * branches are still pinned here.
 *
 * Unlike the file-edit migration there is no query string anywhere in this API,
 * so nothing changed encoding: the one variable is a name in the path, which
 * both the builder and the client percent-encode, a space as `%20`.
 */

const SESSION = 'session/a';
const HUB = '/api/plugins/prompts';
const SESSION_MOUNT = '/api/workspaces/test-workspace/sessions/session%2Fa/plugins/prompts';

beforeAll(() => {
  bindSessionApiWorkspace(() => 'test-workspace');
});

/** The one segment the client cannot fill: Hono's `:name`, as the page substitutes it. */
function named(url: string, name: string): string {
  return url.replace('/:name', `/${encodeURIComponent(name)}`);
}

describe('the URLs this package sends', () => {
  it('reads the library from the hub when no session is named', () => {
    expect(api.global.list.url()).toBe(`${HUB}/prompts`);
  });

  it('reads the library from a focused session s own copy', () => {
    expect(api.session(SESSION).list.url()).toBe(`${SESSION_MOUNT}/prompts`);
  });

  it('writes and deletes one prompt by name, in both scopes', () => {
    expect(named(api.global.save.url(), 'review')).toBe(`${HUB}/prompts/review`);
    expect(named(api.global.remove.url(), 'review')).toBe(`${HUB}/prompts/review`);
    expect(named(api.session(SESSION).save.url(), 'review')).toBe(`${SESSION_MOUNT}/prompts/review`);
    expect(named(api.session(SESSION).remove.url(), 'review')).toBe(`${SESSION_MOUNT}/prompts/review`);
  });

  it('differs between the write and the delete by method alone', () => {
    expect(api.global.list.spec.method).toBe('GET');
    expect(api.global.save.spec.method).toBe('PUT');
    expect(api.global.remove.spec.method).toBe('DELETE');
    expect(api.global.save.spec.path).toBe(api.global.remove.spec.path);
  });

  it('escapes a name that would otherwise change the path, a space as %20', () => {
    expect(named(api.global.save.url(), 'a b')).toBe(`${HUB}/prompts/a%20b`);
    expect(named(api.global.save.url(), 'a/b')).toBe(`${HUB}/prompts/a%2Fb`);
    expect(named(api.global.save.url(), '../escape')).toBe(`${HUB}/prompts/..%2Fescape`);
    expect(named(api.session(SESSION).remove.url(), 'a b#c&d')).toBe(`${SESSION_MOUNT}/prompts/a%20b%23c%26d`);
  });

  it('stays root-relative, which is the only form the sealed relay forwards', () => {
    for (const url of [api.global.list.url(), api.session(SESSION).list.url()]) {
      expect(url.startsWith('/api/')).toBe(true);
      expect(url.startsWith('//')).toBe(false);
    }
  });
});
