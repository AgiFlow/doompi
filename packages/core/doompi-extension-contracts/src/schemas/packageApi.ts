/**
 * The HTTP surface a package offers its host.
 *
 * A package declares one in package.json under `doompiApi`, naming an entry per
 * scope. Which host mounts it follows from that scope: a session-scoped API is
 * served by the session's own doompi-server, a hub-scoped one by the cockpit
 * hub. The package writes routes once and never learns which process ran them.
 *
 * The handler is a plain fetch callback so no host and no package is committed
 * to one HTTP framework; a Hono app satisfies it through `app.fetch`.
 */

import type { DoomMcpProjection } from './mcpProjection.ts';

/** The host-owned sync view a repository-scoped package API may inspect. */
export interface DoomRepositorySyncView {
  fresh: boolean;
  reasons: string[];
  mcpProjection?: DoomMcpProjection;
}

/** Where an API runs: inside one session's server, or in the machine-wide hub. */
export type DoomApiScope = 'session' | 'hub';

export const DOOM_API_SCOPES: readonly DoomApiScope[] = ['session', 'hub'];

/** The segment an API is mounted under, below this prefix. */
export const DOOM_API_ROUTE_PREFIX = '/api/plugin';

/** Absolute unix socket path exposed to processes inside a session server. */
export const DOOM_API_SOCKET_ENV = 'DOOMPI_SESSION_API_SOCKET';
/** Bearer token for agent-only routes on a session API socket. */
export const DOOM_API_INTERNAL_TOKEN_ENV = 'DOOMPI_SESSION_API_INTERNAL_TOKEN';

/** What the host tells an API about itself when it starts. */
export interface DoomApiContext {
  scope: DoomApiScope;
  /** The session this host serves; absent for a hub-scoped API. */
  sessionId?: string;
  /** The session's working directory; absent for a hub-scoped API. */
  cwd?: string;
  /** Shared only with child processes in this session, never with remote API clients. */
  internalToken?: string;
  /** Shared only with the cockpit hub for privileged cross-session coordination. */
  hubToken?: string;
  /**
   * Resolves a hub-issued opaque repository id to an admitted canonical root.
   * Hub APIs must never accept a browser-supplied filesystem path instead.
   */
  resolveRepository?(repositoryId: string): string | undefined;
  /** Reads the admitted repository's sync projection without exposing its state path. */
  readRepositorySync?(repositoryId: string): DoomRepositorySyncView | undefined;
  onNotice(message: string): void;
}

/**
 * One running surface. The host strips the mount prefix before calling, so
 * routes are declared relative ('/runners/:id/log') and a package never
 * repeats where it was mounted.
 */
export interface DoomApiHandler {
  fetch(request: Request): Response | Promise<Response>;
  close(): void;
}

export interface DoomApi {
  /** Segment under /api/plugin/; globally unique across loaded packages. */
  basePath: string;
  start(context: DoomApiContext): DoomApiHandler;
}

/** The named export a declared entry must provide, so a host can find it. */
export const DOOM_API_EXPORT = 'api';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows a module's export to an API, so a broken package is a notice rather than a crash. */
export function isDoomApi(value: unknown): value is DoomApi {
  if (!isRecord(value)) return false;
  return typeof value.basePath === 'string' && value.basePath !== '' && typeof value.start === 'function';
}

/** The package.json field a package declares its API under. */
export const DOOM_API_MANIFEST_FIELD = 'doompiApi';

const BASE_PATH_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface DoomApiEntryDeclaration {
  /** Package-relative ./path to the source entry. */
  entry: string;
  /** Package-relative ./path to the built entry, which is what a host imports. */
  dist?: string;
}

/** One package's declaration, validated, with an entry per scope it offers. */
export interface DeclaredPackageApi {
  basePath: string;
  packageDir: string;
  packageName: string;
  session?: DoomApiEntryDeclaration;
  hub?: DoomApiEntryDeclaration;
}

export class DoomApiManifestError extends Error {
  constructor(packageDir: string, message: string) {
    super(`${DOOM_API_MANIFEST_FIELD} manifest in ${packageDir}: ${message}`);
    this.name = 'DoomApiManifestError';
  }
}

function normalizeEntry(packageDir: string, scope: DoomApiScope, value: unknown): DoomApiEntryDeclaration {
  const raw = typeof value === 'string' ? { entry: value } : value;
  if (!isRecord(raw)) throw new DoomApiManifestError(packageDir, `${scope} must be a path or {entry, dist}.`);
  const { entry, dist } = raw;
  if (typeof entry !== 'string' || !entry.startsWith('./') || entry.includes('..')) {
    throw new DoomApiManifestError(packageDir, `${scope}.entry must be a package-relative ./path with no '..'.`);
  }
  if (dist !== undefined && (typeof dist !== 'string' || !dist.startsWith('./') || dist.includes('..'))) {
    throw new DoomApiManifestError(packageDir, `${scope}.dist must be a package-relative ./path with no '..'.`);
  }
  if (typeof dist !== 'string') {
    throw new DoomApiManifestError(
      packageDir,
      `${scope}.dist is required: a host imports the built entry the package ships, never its source.`,
    );
  }
  return { entry, dist };
}

/**
 * Validates one package.json's `doompiApi` block. A block naming neither scope
 * is an error rather than an empty result: declaring an API that no host can
 * ever mount is a mistake worth reporting where it was made.
 */
export function declaredApisOf(packageDir: string, manifest: Record<string, unknown>): DeclaredPackageApi[] {
  const declared = manifest[DOOM_API_MANIFEST_FIELD];
  if (declared === undefined) return [];
  const blocks = Array.isArray(declared) ? declared : [declared];
  const apis: DeclaredPackageApi[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) throw new DoomApiManifestError(packageDir, 'each block must be an object.');
    const { basePath, session, hub } = block;
    if (typeof basePath !== 'string' || !BASE_PATH_PATTERN.test(basePath)) {
      throw new DoomApiManifestError(packageDir, `basePath '${String(basePath)}' must be kebab-case.`);
    }
    if (session === undefined && hub === undefined) {
      throw new DoomApiManifestError(packageDir, `'${basePath}' names neither a session nor a hub entry.`);
    }
    apis.push({
      basePath,
      packageDir,
      packageName: typeof manifest.name === 'string' ? manifest.name : packageDir,
      ...(session === undefined ? {} : { session: normalizeEntry(packageDir, 'session', session) }),
      ...(hub === undefined ? {} : { hub: normalizeEntry(packageDir, 'hub', hub) }),
    });
  }
  return apis;
}

/**
 * The deterministic order hosts mount in, with cross-package collisions settled
 * the way every other shared name is: the first package keeps the base path and
 * the later one is dropped with a notice.
 */
export function orderDeclaredApis(
  apis: readonly DeclaredPackageApi[],
  onNotice: (message: string) => void = () => undefined,
): DeclaredPackageApi[] {
  const sorted = [...apis].sort(
    (left, right) => left.basePath.localeCompare(right.basePath) || left.packageDir.localeCompare(right.packageDir),
  );
  const owners = new Map<string, DeclaredPackageApi>();
  const kept: DeclaredPackageApi[] = [];
  for (const api of sorted) {
    const holder = owners.get(api.basePath);
    if (holder !== undefined) {
      onNotice(
        `package API '${api.basePath}' from ${api.packageDir} is skipped: ${holder.packageDir} already claims it.`,
      );
      continue;
    }
    owners.set(api.basePath, api);
    kept.push(api);
  }
  return kept;
}
