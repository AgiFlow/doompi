/**
 * The HTTP surface a package offers its host.
 *
 * A server facet registers one with its host. The host mounts it under the API
 * route prefix, and the package writes routes relative to that mount.
 *
 * The handler is a plain fetch callback so no host and no package is committed
 * to one HTTP framework; a Hono app satisfies it through `app.fetch`.
 */

import type { DoomDirectEventBus, DoomHubSessionService } from './hubChannel.ts';
import type { DoomMcpProjection } from './mcpProjection.ts';
/** The host-owned sync view a repository-scoped package API may inspect. */
export interface DoomRepositorySyncView {
  fresh: boolean;
  reasons: string[];
  mcpProjection?: DoomMcpProjection;
}

/** Where an API runs: inside one session's server, or in the machine-wide hub. */
export type DoomApiScope = 'global' | 'workspace' | 'session';

export const DOOM_API_SCOPES: readonly DoomApiScope[] = ['global', 'workspace', 'session'];

/** Identity of an independently mounted plugin host. */
export type DoomApiMount =
  | { scope: 'global' }
  | { scope: 'workspace'; workspaceId: string }
  | { scope: 'session'; sessionId: string };

/** Immutable browser contribution generation paired with a server mount. */
export interface DoomWebComposition {
  id: string;
  scope: DoomApiScope;
  revision: number;
  manifestUrl: string;
  rawAssetBaseUrl: string;
  verifiedAssetBaseUrl: string;
  entryPath: string;
  stylePaths: string[];
  channels: string[];
}

/** Canonical public prefix. Scope selection never falls through to a parent. */
export function doomApiMountPath(mount: DoomApiMount): string {
  if (mount.scope === 'global') return '/api/global/plugin';
  if (mount.scope === 'workspace') return `/api/workspaces/${encodeURIComponent(mount.workspaceId)}/plugin`;
  return `/api/sessions/${encodeURIComponent(mount.sessionId)}/plugin`;
}

/** The segment an API is mounted under, below this prefix. */
export const DOOM_API_ROUTE_PREFIX = '/api/plugin';
/** Selects the hub API bundle that owns the named cockpit session. */
export const DOOM_HUB_API_SESSION_QUERY_PARAM = 'hubSession';

/** Trusted caller headers written only by the cockpit-to-session proxy. */
export const DOOM_API_CALLER_LOCALITY_HEADER = 'x-doompi-api-caller-locality';
export const DOOM_API_CALLER_DEVICE_ID_HEADER = 'x-doompi-api-caller-device-id';
export const DOOM_API_CALLER_STEP_UP_HEADER = 'x-doompi-api-caller-step-up';
export const DOOM_API_CALLER_HEADERS = [
  DOOM_API_CALLER_LOCALITY_HEADER,
  DOOM_API_CALLER_DEVICE_ID_HEADER,
  DOOM_API_CALLER_STEP_UP_HEADER,
] as const;

export type DoomApiCallerStepUp = 'not-required' | 'verified' | 'unavailable';
export type DoomApiCaller =
  | { locality: 'local'; stepUp: 'not-required' }
  | { locality: 'remote'; deviceId: string; stepUp: DoomApiCallerStepUp };

/** Reads the proxy-authenticated caller identity, rejecting partial or contradictory stamps. */
export function doomApiCallerFrom(headers: Headers): DoomApiCaller | undefined {
  const locality = headers.get(DOOM_API_CALLER_LOCALITY_HEADER);
  const deviceId = headers.get(DOOM_API_CALLER_DEVICE_ID_HEADER);
  const stepUp = headers.get(DOOM_API_CALLER_STEP_UP_HEADER);
  if (locality === 'local') {
    return deviceId === null && stepUp === 'not-required' ? { locality, stepUp } : undefined;
  }
  if (
    locality === 'remote' &&
    deviceId !== null &&
    deviceId !== '' &&
    (stepUp === 'not-required' || stepUp === 'verified' || stepUp === 'unavailable')
  ) {
    return { locality, deviceId, stepUp };
  }
  return undefined;
}
/**
 * A browser-reachable OAuth redirect the host serves on its own listener.
 *
 * A package brokering third-party OAuth cannot use a loopback redirect when the
 * operator's browser is on another machine: `127.0.0.1` resolves to whichever
 * machine the browser runs on. The host owns a listener that is reachable from
 * wherever the cockpit is being used, so it lends that instead of the package
 * opening a port of its own.
 */
export interface DoomOAuthRedirect {
  /** Absolute URL to register as the redirect target, already origin-correct. */
  readonly redirectUri: string;
  /**
   * Accept redirects carrying this state. Must complete before the
   * authorization URL is surfaced, or the redirect races its own reservation.
   */
  reserve(state: string, timeoutMs?: number): Promise<void>;
  /** Resolves once the redirect carrying this state arrives. */
  wait(state: string, timeoutMs?: number): Promise<{ code: string; state: string }>;
  /** Drops a reservation whose flow ended without a redirect. */
  cancel(state: string): void;
}

/** What the host tells an API about itself when it starts. */
export interface DoomApiContext {
  scope: DoomApiScope;
  /** Stable, opaque identity shared by sessions in one canonical worktree. */
  workspaceId?: string;
  /** Canonical admitted workspace root, absent from global mounts. */
  workspaceRoot?: string;
  /** Explicit host home, never selected by a remote request. */
  homeDirectory?: string;
  /** The session this host serves; absent for a hub-scoped API. */
  sessionId?: string;
  /** The session's working directory; absent for a hub-scoped API. */
  cwd?: string;
  /** Session environment admitted by the server, never supplied by remote clients. */
  environment?: Readonly<Record<string, string | undefined>>;
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
  /** Admitted workspaces available to this mount. */
  repositories?(): readonly { id: string; name: string; path: string; active: boolean }[];
  /** Publish a successful config write to the owning mount's refresh lifecycle. */
  configurationChanged?(): void;
  /**
   * Borrows the hub's OAuth redirect surface. Undefined when the hub cannot
   * currently serve one, in which case the package keeps its own behaviour.
   */
  oauthRedirect?(): DoomOAuthRedirect | undefined;
  /** Canonical in-process lifecycle for sessions created by this host. */
  sessionService?: DoomHubSessionService;
  /** Same-process events shared by session APIs and hub channels. */
  directEvents?: DoomDirectEventBus;
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
