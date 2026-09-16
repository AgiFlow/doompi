import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeAll, describe, expect, it } from 'vitest';

import { api } from '../../generated/client';

/**
 * Pins every URL this package sends, as a literal string.
 *
 * These were captured from the hand-written builders before they were deleted,
 * so they are the shapes the cockpit has always sent, not the shapes the
 * current code happens to produce. Keeping them literal is the point: a
 * mistyped mount is not reported by the route it misses, because the service
 * worker answers any unrecognised path out of the signed bundle cache.
 *
 * Two differences from the old builders are deliberate. `?session=` is gone,
 * having been appended by every builder and read by nothing. And a space is
 * `%20` rather than the `+` that `URLSearchParams` wrote, which is the encoding
 * the host's own file route already used.
 */

const SESSION = 's1';

beforeAll(() => {
  bindSessionApiWorkspace(() => 'test-workspace');
});

const MOUNT = '/api/workspaces/test-workspace/sessions/s1';
const scoped = () => api.session(SESSION);

describe('the URLs this package sends', () => {
  it('reads one file s detail', () => {
    expect(scoped().detail.url({ query: { path: 'a.ts' } })).toBe(`${MOUNT}/plugins/file-edits/detail?path=a.ts`);
  });

  it('reads an unchanged file', () => {
    expect(scoped().preview.url({ query: { path: 'docs/report.pdf' } })).toBe(
      `${MOUNT}/plugins/file-edits/preview?path=docs%2Freport.pdf`,
    );
  });

  it('puts a manual save, which carries no query', () => {
    expect(scoped().save.url()).toBe(`${MOUNT}/plugins/file-edits/content`);
  });

  it('deletes through the same path a save uses, differing only by method', () => {
    expect(scoped().remove.url({ query: { path: 'a.ts' } })).toBe(`${MOUNT}/plugins/file-edits/content?path=a.ts`);
    expect(scoped().remove.spec.method).toBe('DELETE');
    expect(scoped().save.spec.method).toBe('PUT');
  });

  it('reads raw bytes from the host route, which sits outside /plugins', () => {
    expect(scoped().file.url({ query: { path: 'docs/report.pdf' } })).toBe(`${MOUNT}/file?path=docs%2Freport.pdf`);
  });

  it('escapes a space as %20, a slash, a hash and an ampersand', () => {
    expect(scoped().detail.url({ query: { path: 'a b#c&d/e.ts' } })).toBe(
      `${MOUNT}/plugins/file-edits/detail?path=a%20b%23c%26d%2Fe.ts`,
    );
  });

  it('sends no session parameter, which nothing ever read', () => {
    for (const url of [
      scoped().detail.url({ query: { path: 'a.ts' } }),
      scoped().preview.url({ query: { path: 'a.ts' } }),
      scoped().save.url(),
      scoped().remove.url({ query: { path: 'a.ts' } }),
    ]) {
      expect(url).not.toContain('session=');
    }
  });

  it('stays root-relative, which is the only form the sealed relay forwards', () => {
    const url = scoped().detail.url({ query: { path: 'a.ts' } });
    expect(url.startsWith('/api/')).toBe(true);
    expect(url.startsWith('//')).toBe(false);
  });
});
