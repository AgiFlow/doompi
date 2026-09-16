import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeAll, describe, expect, it } from 'vitest';

import { api } from '../../generated/client';
import { ARTIFACT_NAME_PARAM } from '../../src/types/apiRoutes';

/**
 * Pins every URL this package sends, as a literal string, at every scope it
 * mounts at.
 *
 * These were captured from the hand-written builders before they were deleted,
 * so they are the shapes the cockpit has always sent, not the shapes the
 * current code happens to produce. Keeping them literal is the point: a
 * mistyped mount is not reported by the route it misses, because the service
 * worker answers any unrecognised path out of the signed bundle cache.
 *
 * All three scopes are pinned because the two the page used produced their URLs
 * by different means. `workflowRunPath()` built an absolute
 * `/api/plugins/workflow/...` string, which was the hub form; the session form
 * was that same string with `/api/plugins/` rewritten by `String.replace` into
 * `${sessionApiPath(id)}/plugins/`. The workspace form was never reachable at
 * all, though the API has always answered there, because a global contribution
 * cascades into workspace and session.
 *
 * Nothing changed encoding: the workspace and the run key were percent-encoded
 * by the old builder and are percent-encoded by the client, a space as `%20`,
 * and an artifact's nested path keeps its literal slashes in both.
 */

const WORKSPACE = 'repo/a';
const RUN_KEY = 'run one';
const SESSION = 'session/a';

/** Every URL below names this one run, encoded exactly as the old builder encoded it. */
const RUN = 'runs/repo%2Fa/run%20one';

const HUB = `/api/plugins/workflow/${RUN}`;
const WORKSPACE_MOUNT = `/api/workspaces/test-workspace/plugins/workflow/${RUN}`;
const SESSION_MOUNT = `/api/workspaces/test-workspace/sessions/session%2Fa/plugins/workflow/${RUN}`;

beforeAll(() => {
  bindSessionApiWorkspace(() => 'test-workspace');
});

const params = { workspace: WORKSPACE, runKey: RUN_KEY };

/** The scopes the tree mounts at, each paired with the mount it answers on. */
const scopes = [
  { name: 'the hub', at: () => api.global, mount: HUB },
  { name: 'a workspace', at: () => api.workspace('test-workspace'), mount: WORKSPACE_MOUNT },
  { name: 'a session', at: () => api.session(SESSION), mount: SESSION_MOUNT },
] as const;

/**
 * The one segment the client cannot fill: Hono's multi-segment `:name{.+}`, as
 * the page substitutes it, slashes kept and each segment encoded on its own.
 */
function named(url: string, artifactPath: string): string {
  return url.replace(ARTIFACT_NAME_PARAM, artifactPath.split('/').map(encodeURIComponent).join('/'));
}

describe('the URLs this package sends', () => {
  for (const scope of scopes) {
    describe(`addressing ${scope.name}`, () => {
      it('follows the screen, which is the stream an EventSource opens', () => {
        expect(scope.at().screen.url({ params })).toBe(`${scope.mount}/screen/stream`);
      });

      it('takes, renews and releases the keyboard through one route', () => {
        expect(scope.at().control.url({ params })).toBe(`${scope.mount}/control`);
      });

      it('writes keystrokes and resizes the terminal', () => {
        expect(scope.at().keys.url({ params })).toBe(`${scope.mount}/keys`);
        expect(scope.at().resize.url({ params })).toBe(`${scope.mount}/resize`);
      });

      it('deletes the run through the run itself, which carries no suffix', () => {
        expect(scope.at().remove.url({ params })).toBe(scope.mount);
      });

      it('lists the run directory', () => {
        expect(scope.at().artifacts.url({ params })).toBe(`${scope.mount}/artifacts`);
      });

      it('reads one artifact, keeping the slashes of a nested path', () => {
        expect(named(scope.at().artifact.url({ params }), 'reports/a b.md')).toBe(
          `${scope.mount}/artifacts/reports/a%20b.md`,
        );
      });

      it('streams raw bytes, and forces a download, through the same artifact route', () => {
        expect(named(scope.at().artifact.url({ params, query: { raw: 1 } }), 'report.md')).toBe(
          `${scope.mount}/artifacts/report.md?raw=1`,
        );
        expect(named(scope.at().artifact.url({ params, query: { raw: 1, download: 1 } }), 'report.md')).toBe(
          `${scope.mount}/artifacts/report.md?raw=1&download=1`,
        );
      });

      it('stays root-relative, which is the only form the sealed relay forwards', () => {
        const url = scope.at().artifacts.url({ params });
        expect(url.startsWith('/api/')).toBe(true);
        expect(url.startsWith('//')).toBe(false);
      });
    });
  }

  it('differs between the routes sharing a path by method alone', () => {
    expect(api.global.remove.spec.method).toBe('DELETE');
    expect(api.global.artifacts.spec.method).toBe('GET');
    expect(api.global.control.spec.method).toBe('POST');
    expect(api.global.keys.spec.method).toBe('POST');
    expect(api.global.resize.spec.method).toBe('POST');
  });

  it('offers the screen as an address only, because a relayed stream never returns', () => {
    expect(api.global.screen.spec.stream).toBe(true);
    expect(typeof api.global.screen).toBe('object');
  });

  it('escapes a run key that would otherwise change the path', () => {
    expect(api.global.artifacts.url({ params: { workspace: 'a b', runKey: 'a/b#c&d' } })).toBe(
      '/api/plugins/workflow/runs/a%20b/a%2Fb%23c%26d/artifacts',
    );
  });
});
