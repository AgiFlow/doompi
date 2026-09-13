import type { Context } from '@deepseek-ai/cordis';
/**
 * The server facet a package installs into a headless host.
 *
 * A package already ships a Pi extension facet for the agent process. This is
 * the second facet: one cordis plugin that a session server or the cockpit hub
 * installs, through which the package contributes its HTTP surface and any
 * behaviour that has to run outside the agent.
 *
 * A facet is installed and disposed like every other Doom contribution. It
 * registers its API from inside that lifecycle, so server behaviour has a clear
 * owner and disposer.
 */
import type { Static, TSchema } from 'typebox';

import type { DoomHeadlessHostService, DoomHeadlessToolRestriction } from './headless';
import type { DoomHeadlessTool, DoomHeadlessCommand } from './headless';
import type { DoomHubChannel } from './hubChannel';
import type { DoomApi, DoomApiContext, DoomApiScope } from './packageApi';
import type { DoomPluginTool, DoomPluginCommand } from './pluginContributions';
import type { DoomPluginCaller, DoomPluginMethod } from './pluginProtocol';
import type { DoomToolRestrictionDefinition } from './toolSurface';

/** The host a server facet contributes to. */
export const DOOM_SERVER_HOST_SERVICE = 'doom/server-host';

export interface DoomServerRegistration {
  /** Whether the API was mounted. A refused registration is a no-op handle. */
  readonly mounted?: boolean;
  /** Unmount the surface and close its handler. Idempotent. */
  dispose(): void;
}

/**
 * What a facet is handed when it installs.
 *
 * `scope` is fixed for the life of the host: a session server never becomes a
 * hub. A facet that only makes sense in one scope returns early in the other
 * rather than declaring itself twice.
 */
export interface DoomServerHostService {
  readonly scope: DoomApiScope;
  /** Identity and host-lent capabilities, the same record an API is started with. */
  readonly context: DoomApiContext;
  /**
   * Mount an API under its own base path. A base path already claimed by an
   * earlier facet is refused with a notice and a no-op handle. The same
   * failure posture applies when the API cannot start or the host is disposed.
   */
  registerApi(api: DoomApi): DoomServerRegistration;
  /** Register a live event source under this host's lifecycle. */
  registerChannel(channel: DoomHubChannel): DoomServerRegistration;
  /** Mount a typed call at this host's exact scope. */
  registerMethod<TInput extends TSchema, TOutput extends TSchema>(
    definition: DoomPluginMethod<TInput, TOutput>,
    handler: (input: Static<TInput>, caller: DoomPluginCaller) => Static<TOutput> | Promise<Static<TOutput>>,
  ): DoomServerRegistration;
  /** Base paths currently mounted, in mount order. */
  mounted(): readonly string[];
  /** Channel frame types currently mounted, in mount order. */
  mountedChannels(): readonly string[];
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/server-host': DoomServerHostService;
  }
}

export function readDoomServerHost(context: Context): DoomServerHostService | undefined {
  return context.get(DOOM_SERVER_HOST_SERVICE) as DoomServerHostService | undefined;
}

export function requireDoomServerHost(context: Context): DoomServerHostService {
  const service = readDoomServerHost(context);
  if (!service) throw new Error('The Doom server host is unavailable. Start a Doom server first.');
  return service;
}

/** The package.json field a package declares its server facet under. */
export const DOOM_SERVER_FACET_MANIFEST_FIELD = 'doompiServer';

/** The default export a facet module must provide, so a host can install it. */
export const DOOM_SERVER_FACET_EXPORT = 'default';

/**
 * One package's server contributions, as a Cordis object plugin.
 *
 * The object form rather than a bare function, because it is the only shape
 * that declares its own `inject`. That matters to a host: a plugin carrying
 * its dependencies is a single fiber, so `fiber.await()` settles once `apply`
 * has run, and the host can decide whether to open a listener from a mount
 * table it knows is complete. A function facet calling `ctx.inject` inside
 * itself mounts a child fiber that the host has no handle on.
 *
 * A returned function is the disposer, run when the host's root unwinds.
 */
export interface DoomServerFacet {
  readonly inject?: readonly string[];
  apply(context: Context): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

/** One instance belongs to one mounted server scope. */
export interface DoomServerPluginContext {
  readonly context: Context;
  readonly host: DoomServerHostService;
  readonly agent?: DoomHeadlessHostService;
  readonly signal: AbortSignal;
}

export interface DoomServerMethod {
  register(host: DoomServerHostService): DoomServerRegistration;
}

/** Capture schema inference before heterogeneous methods enter a contribution array. */
export function defineServerMethod<TInput extends TSchema, TOutput extends TSchema>(
  definition: DoomPluginMethod<TInput, TOutput>,
  handler: (input: Static<TInput>, caller: DoomPluginCaller) => Static<TOutput> | Promise<Static<TOutput>>,
): DoomServerMethod {
  return { register: (host) => host.registerMethod(definition, handler) };
}

export interface DoomServerPluginScope {
  readonly services?: readonly Parameters<Context['plugin']>[0][];
  readonly channels?: readonly (() => DoomHubChannel)[];
  readonly api?: readonly DoomApi[];
  readonly methods?: readonly DoomServerMethod[];
  readonly onStart?: (context: DoomServerPluginContext) => void | Promise<void>;
  readonly onStop?: (context: DoomServerPluginContext) => void | Promise<void>;
  readonly onDispose?: (context: DoomServerPluginContext) => void | Promise<void>;
}

export interface DoomServerSessionPlugin extends DoomServerPluginScope {
  readonly tools?: readonly (DoomHeadlessTool | DoomPluginTool)[];
  readonly commands?: readonly (DoomHeadlessCommand | DoomPluginCommand)[];
  readonly resources?: readonly Parameters<DoomHeadlessHostService['registerResource']>[0][];
  readonly hooks?: readonly Parameters<DoomHeadlessHostService['registerHook']>[0][];
  readonly toolRestrictions?: readonly (
    | DoomHeadlessToolRestriction
    | DoomToolRestrictionDefinition<() => DoomHeadlessToolRestriction>
  )[];
  readonly activities?: readonly Parameters<DoomHeadlessHostService['registerActivity']>[0][];
}

type ScopeDeclaration<TScope> = TScope | ((context: DoomServerPluginContext) => TScope | Promise<TScope>);
// Explicitly forbid session contributions even when a factory returns an inferred object.
type NonSessionScope = DoomServerPluginScope & {
  readonly [K in Exclude<keyof DoomServerSessionPlugin, keyof DoomServerPluginScope>]?: never;
};
export interface DoomServerPluginDefinition {
  readonly name: string;
  readonly inject?: readonly string[];
  readonly global?: ScopeDeclaration<NonSessionScope>;
  readonly workspace?: ScopeDeclaration<NonSessionScope>;
  readonly session?: ScopeDeclaration<DoomServerSessionPlugin>;
}

/** One package's validated declaration. */
export interface DeclaredServerFacet {
  packageName: string;
  packageDir: string;
  /** Package-relative ./path to the source entry. */
  entry: string;
  /** Package-relative ./path to the built entry, which is what a host imports. */
  dist: string;
  /** Scopes this facet is installed into; both when the package names neither. */
  scopes: readonly DoomApiScope[];
  /** A selected host cannot be ready without this package's runtime capability. */
  required?: boolean;
}

export class DoomServerFacetManifestError extends Error {
  constructor(packageDir: string, message: string) {
    super(`${DOOM_SERVER_FACET_MANIFEST_FIELD} manifest in ${packageDir}: ${message}`);
    this.name = 'DoomServerFacetManifestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows a module's default export, so a broken package is a notice rather than a crash. */
export function isDoomServerFacet(value: unknown): value is DoomServerFacet {
  return isRecord(value) && typeof value.apply === 'function';
}

function normalizePath(packageDir: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('./') || value.includes('..')) {
    throw new DoomServerFacetManifestError(packageDir, `${field} must be a package-relative ./path with no '..'.`);
  }
  return value;
}

function normalizeScopes(packageDir: string, value: unknown): readonly DoomApiScope[] {
  if (value === undefined) throw new DoomServerFacetManifestError(packageDir, 'scopes must be declared explicitly.');
  if (!Array.isArray(value) || value.length === 0) {
    throw new DoomServerFacetManifestError(packageDir, "scopes must name 'global', 'workspace', or 'session'.");
  }
  const scopes: DoomApiScope[] = [];
  for (const scope of value) {
    if (scope !== 'session' && scope !== 'global' && scope !== 'workspace') {
      throw new DoomServerFacetManifestError(
        packageDir,
        `Unknown scope '${String(scope)}'; resync for the three-level host.`,
      );
    }
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

/**
 * Validates one package.json's `doompiServer` block.
 *
 * `dist` is required because a host imports the built entry the package ships,
 * never its source.
 */
export function declaredServerFacetsOf(packageDir: string, manifest: Record<string, unknown>): DeclaredServerFacet[] {
  const declared = manifest[DOOM_SERVER_FACET_MANIFEST_FIELD];
  if (declared === undefined) return [];
  if (!isRecord(declared)) {
    throw new DoomServerFacetManifestError(packageDir, 'the block must be an object naming entry and dist.');
  }
  const entry = normalizePath(packageDir, 'entry', declared.entry);
  if (declared.dist === undefined) {
    throw new DoomServerFacetManifestError(
      packageDir,
      'dist is required: a host imports the built entry the package ships, never its source.',
    );
  }
  const dist = normalizePath(packageDir, 'dist', declared.dist);
  if (declared.required !== undefined && typeof declared.required !== 'boolean') {
    throw new DoomServerFacetManifestError(packageDir, 'required must be a boolean.');
  }
  return [
    {
      packageName: typeof manifest.name === 'string' ? manifest.name : packageDir,
      packageDir,
      entry,
      dist,
      scopes: normalizeScopes(packageDir, declared.scopes),
      ...(typeof declared.required === 'boolean' ? { required: declared.required } : {}),
    },
  ];
}

/**
 * The deterministic order hosts install in. A package appears once: the first
 * directory claiming a package name keeps it and the later one is dropped with
 * a notice, so a duplicated install never installs a facet twice.
 */
export function orderServerFacets(
  facets: readonly DeclaredServerFacet[],
  onNotice: (message: string) => void = () => undefined,
): DeclaredServerFacet[] {
  const sorted = [...facets].sort(
    (left, right) =>
      left.packageName.localeCompare(right.packageName) || left.packageDir.localeCompare(right.packageDir),
  );
  const owners = new Map<string, DeclaredServerFacet>();
  const kept: DeclaredServerFacet[] = [];
  for (const facet of sorted) {
    const holder = owners.get(facet.packageName);
    if (holder !== undefined) {
      onNotice(
        `server facet '${facet.packageName}' from ${facet.packageDir} is skipped: ${holder.packageDir} already claims it.`,
      );
      continue;
    }
    owners.set(facet.packageName, facet);
    kept.push(facet);
  }
  return kept;
}
