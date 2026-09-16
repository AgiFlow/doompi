/**
 * The byte shape of every URL the browser addresses a package API with.
 *
 * One implementation, because the alternative is what the cockpit had: twelve
 * packages each concatenating `${sessionApiPath(id)}/plugins/${base}${path}` by
 * hand, three of them spelling the prefix a fourth way, and one rewriting it
 * with `String.replace`. A route that moves by one character is answered by the
 * service worker out of the signed bundle cache instead of the network, so the
 * failure is a 404 nowhere near its cause.
 *
 * The host builds the same strings from `doomApiMountPath` and, for OpenAPI
 * templating, from `createApiDocuments`. Those live in the node half of this
 * package and cannot be imported here: `src/web` is a separate tree that reads
 * neither `src/schemas` nor `src/services`. The three are held together by the
 * agreement test instead of by a call, which is the guarantee that matters.
 */

/**
 * Who a request is addressed to. Ids are supplied decoded and encoded here, so
 * a caller never double-encodes and a workspace with a slash in its name cannot
 * forge a path segment.
 */
export type ApiScopeAddress =
  | { readonly scope: 'global' }
  | { readonly scope: 'workspace'; readonly workspaceId: string }
  | { readonly scope: 'session'; readonly workspaceId: string; readonly sessionId: string };

/** Path parameter values, substituted into a route's `:name` segments. */
export type ApiParams = Readonly<Record<string, string>>;

/** Query values a route may carry. `undefined` drops the parameter rather than sending 'undefined'. */
export type ApiQuery = Readonly<Record<string, string | number | boolean | undefined>>;

/** The base path the host reserves for its own settings API, mounted outside /plugins/. */
export const SETTINGS_BASE_PATH = 'settings';

/** The scope's own resource root: what a host-owned route hangs off. */
export function scopeApiRoot(address: ApiScopeAddress): string {
  if (address.scope === 'global') return '/api';
  const workspace = `/api/workspaces/${encodeURIComponent(address.workspaceId)}`;
  if (address.scope === 'workspace') return workspace;
  return `${workspace}/sessions/${encodeURIComponent(address.sessionId)}`;
}

/**
 * The mount one package API answers on.
 *
 * `basePath` is omitted for a host-owned route, which the contract schema
 * already spells that way, so the session file-bytes route and a plugin route
 * are the same construction with one field different rather than two code
 * paths. `settings` is the host's own API and sits beside `/plugins`, not
 * under it.
 */
export function pluginApiBase(address: ApiScopeAddress, basePath: string | undefined): string {
  const root = scopeApiRoot(address);
  if (basePath === undefined) return root;
  if (basePath === SETTINGS_BASE_PATH) return `${root}/${SETTINGS_BASE_PATH}`;
  return `${root}/plugins/${basePath}`;
}

/**
 * The query string, `encodeURIComponent` per pair rather than `URLSearchParams`.
 *
 * `URLSearchParams` writes a space as `+`, which only decodes back to a space
 * under form-urlencoded rules; `%20` decodes to a space everywhere. The
 * cockpit already relied on that difference in both directions, so picking the
 * unambiguous one is what lets a single encoder serve every route.
 */
export function apiQueryString(query: ApiQuery | undefined): string {
  if (query === undefined) return '';
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

/**
 * The absolute, root-relative URL for one route.
 *
 * Root-relative on purpose: the sealed transport refuses anything else, because
 * a remote session relays its requests through a gateway that will not forward
 * an arbitrary origin.
 *
 * A route whose path is exactly '/' addresses the mount itself, so the slash is
 * dropped rather than doubled.
 */
export function pluginApiUrl(
  address: ApiScopeAddress,
  basePath: string | undefined,
  path: string,
  query?: ApiQuery,
  params?: ApiParams,
): string {
  const resolved = applyPathParams(path, params);
  return `${pluginApiBase(address, basePath)}${resolved === '/' ? '' : resolved}${apiQueryString(query)}`;
}

/**
 * Substitutes a route's `:name` segments, as Hono spells them.
 *
 * Encoded per segment, so a value containing a slash names one segment rather
 * than inventing another. A declared parameter with no value is left as the
 * literal `:name`, which fails visibly at the route instead of silently
 * addressing the collection above it.
 */
export function applyPathParams(path: string, params: ApiParams | undefined): string {
  if (params === undefined || !path.includes(':')) return path;
  return path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const value = params[segment.slice(1)];
      return value === undefined ? segment : encodeURIComponent(value);
    })
    .join('/');
}
