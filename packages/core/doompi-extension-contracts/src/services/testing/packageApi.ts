import {
  type DoomApi,
  type DoomApiContext,
  type DoomApiHandler,
  DOOM_API_ROUTE_PREFIX,
  type DoomApiScope,
} from '../../schemas/packageApi.ts';

/**
 * A package's HTTP surface, mounted the way a host mounts it.
 *
 * A package tests its routes by calling its Hono app directly, which proves the
 * routes but not the mount: the host serves them under
 * `/api/plugin/<basePath>` and strips that prefix before the app sees the
 * request. A package whose routes are written absolute passes its own suite and
 * answers nothing in a running cockpit.
 *
 * This mounts the declared `DoomApi` the same way, so a test asks for the URL a
 * browser would ask for. Plain `Request` and `Response`; no HTTP framework and
 * no server.
 */

export interface MountPackageApiOptions {
  scope?: DoomApiScope;
  sessionId?: string;
  cwd?: string;
}

export interface MountedPackageApi {
  /** Where the host mounted it, for building a URL the way a client does. */
  readonly mountPath: string;
  /** What the API reported to its host; a package that notices nothing leaves this empty. */
  readonly notices: readonly string[];
  /**
   * Fetches one path.
   *
   * The path is host-absolute, so it carries the mount the client would send:
   * `/api/plugin/workflow/runs/repo/blog-4`. A path outside the mount is a 404
   * from this, exactly as it is from the host.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  close(): void;
}

const DEFAULT_SCOPE: DoomApiScope = 'hub';
const DEFAULT_CWD = '/repo';
/** Any origin will do: the host routes on path, and a Request needs an absolute URL. */
const ORIGIN = 'http://host';

export function mountPackageApi(api: DoomApi, options: MountPackageApiOptions = {}): MountedPackageApi {
  const scope = options.scope ?? DEFAULT_SCOPE;
  const notices: string[] = [];
  const mountPath = `${DOOM_API_ROUTE_PREFIX}/${api.basePath}`;
  const context: DoomApiContext = {
    scope,
    // A session-scoped host knows both; a hub-scoped one knows neither, and an
    // API that reads them anyway should see the same undefined it would there.
    ...(scope === 'session' ? { sessionId: options.sessionId ?? 'test-session', cwd: options.cwd ?? DEFAULT_CWD } : {}),
    onNotice: (message) => notices.push(message),
  };
  const handler: DoomApiHandler = api.start(context);

  return {
    mountPath,
    notices,
    async fetch(path, init) {
      const url = new URL(path, ORIGIN);
      if (url.pathname !== mountPath && !url.pathname.startsWith(`${mountPath}/`)) {
        return new Response(`No package API is mounted at ${url.pathname}.`, { status: 404 });
      }
      // The host strips its own mount, so a package declares '/runs/:id' and
      // never repeats where it was mounted.
      url.pathname = url.pathname.slice(mountPath.length) || '/';
      return handler.fetch(new Request(url, init));
    },
    close: () => handler.close(),
  };
}
