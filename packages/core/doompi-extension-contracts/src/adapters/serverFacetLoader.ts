import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, Service, type Fiber } from '@deepseek-ai/cordis';
import type { DoomApiScope } from '../schemas/packageApi.ts';
import { DOOM_HEADLESS_OWNER, readDoomHeadlessHost } from '../schemas/headless.ts';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  type DoomServerHostService,
  isDoomServerFacet,
} from '../schemas/serverFacet.ts';
import {
  DOOM_SERVER_BUNDLE_FILE,
  type DoomServerBundle,
  type DoomServerBundleEntry,
  parseDoomServerBundle,
} from '../schemas/serverBundle.ts';

export type ServerBundleSource =
  | {
      readonly kind: 'descriptor';
      readonly directory: string;
      readonly generation: string;
      readonly fingerprint: string;
    }
  | { readonly kind: 'empty' };

/** Normalize operator-selected directories without falling back after descriptor errors. */
export function resolveServerBundleSource(options: {
  registration?: {
    readonly apiDirectory: string;
    readonly generation: string;
    readonly serverBundle?: { readonly path: string; readonly fingerprint: string };
  };
  directoryOverride?: string;
}): ServerBundleSource {
  const registration = options.registration;
  const override = options.directoryOverride || undefined;
  const selected = override ?? registration?.apiDirectory;
  if (selected === undefined) return { kind: 'empty' };
  const directory = fs.realpathSync(selected);
  const isRegisteredDirectory = registration !== undefined && directory === fs.realpathSync(registration.apiDirectory);
  if (isRegisteredDirectory && registration.serverBundle !== undefined) {
    // The registration already declares this as new format, even when the file
    // was removed after admission. loadServerBundle must reject, never downgrade.
    return {
      kind: 'descriptor',
      directory,
      generation: registration.generation,
      fingerprint: registration.serverBundle.fingerprint,
    };
  }
  const descriptorPath = path.join(directory, DOOM_SERVER_BUNDLE_FILE);
  if (fs.existsSync(descriptorPath)) {
    const descriptor = parseDoomServerBundle(
      JSON.parse(fs.readFileSync(containedFile(directory, DOOM_SERVER_BUNDLE_FILE), 'utf8')),
    );
    return { kind: 'descriptor', directory, generation: descriptor.generation, fingerprint: descriptor.fingerprint };
  }
  throw new Error(`Server bundle descriptor is missing: ${descriptorPath}`);
}

export interface LoadServerBundleOptions {
  /** Already admitted generation directory, not a repository selected by a request. */
  readonly directory: string;
  readonly generation: string;
  readonly fingerprint: string;
  readonly majorMode: string;
  readonly activeLayers: readonly string[];
  readonly onNotice?: (message: string) => void;
  /** Only a session host with declarative contribution gating may retain all candidates. */
  readonly retainCandidates?: boolean;
}

export interface LoadedServerFacet {
  readonly declaration: DoomServerBundleEntry;
  readonly facet: DoomServerFacet;
  readonly retained?: true;
  readonly initiallyEligible?: boolean;
}

export interface LoadedServerBundle {
  readonly descriptor: DoomServerBundle;
  readonly facets: readonly LoadedServerFacet[];
}

function containedFile(directory: string, relativeFile: string): string {
  const resolved = fs.realpathSync(path.resolve(directory, relativeFile));
  const relative = path.relative(directory, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Server bundle file escapes its generation: ${relativeFile}`);
  }
  return resolved;
}

/** Explicit new-generation reader. Missing or corrupt descriptors never select legacy modules. */
export async function loadServerBundle(
  scope: DoomApiScope,
  options: LoadServerBundleOptions,
): Promise<LoadedServerBundle> {
  const directory = fs.realpathSync(options.directory);
  const descriptor = parseDoomServerBundle(
    JSON.parse(fs.readFileSync(containedFile(directory, DOOM_SERVER_BUNDLE_FILE), 'utf8')),
  );
  if (descriptor.generation !== options.generation || descriptor.fingerprint !== options.fingerprint) {
    throw new Error('Server bundle does not match the admitted generation');
  }
  const facets: LoadedServerFacet[] = [];
  for (const declaration of descriptor.entries) {
    if (!declaration.scopes.includes(scope)) continue;
    const eligible = declaration.owners.some(
      (owner) =>
        owner.majorMode === options.majorMode &&
        (owner.layer === 'default' || options.activeLayers.includes(owner.layer)),
    );
    if (!(scope === 'session' && options.retainCandidates === true) && !eligible) continue;
    try {
      const file = containedFile(directory, declaration.module);
      const imported = (await import(pathToFileURL(file).href)) as { default?: unknown };
      if (!isDoomServerFacet(imported.default)) throw new Error('default export is not a server object facet');
      facets.push({
        declaration,
        facet: imported.default,
        ...(scope === 'session' && options.retainCandidates
          ? { retained: true as const, initiallyEligible: eligible }
          : {}),
      });
    } catch (error) {
      const message = `Server facet '${declaration.packageName}' could not load (${error instanceof Error ? error.message : String(error)})`;
      if (declaration.required && eligible) throw new Error(message, { cause: error });
      options.onNotice?.(message);
    }
  }
  return { descriptor, facets };
}
export interface InstallServerFacetsOptions {
  host: DoomServerHostService;
  facets: readonly (DoomServerFacet | LoadedServerFacet)[];
  onNotice?: (message: string) => void;
  /** Install additional typed services before any package facet is applied. */
  prepare?: (root: Context) => void | Promise<void>;
}

export interface InstalledServerFacets {
  /** The cordis root the facets were installed into, for a host that provides more services. */
  readonly root: Context;
  readonly installedPackages: readonly string[];
  dispose(): Promise<void>;
}

/**
 * Binds registrations to the Cordis fiber that calls the host service.
 *
 * The host itself is shared, but Cordis traceable services rebind `ctx` to the
 * caller. That lets a facet's registration unwind even when `apply` throws
 * before it can return its disposer.
 */
class ScopedDoomServerHost extends Service<DoomServerHostService> implements DoomServerHostService {
  readonly scope: DoomServerHostService['scope'];
  readonly context: DoomServerHostService['context'];

  constructor(
    ctx: Context,
    private readonly host: DoomServerHostService,
  ) {
    super(ctx, DOOM_SERVER_HOST_SERVICE);
    this.scope = host.scope;
    this.context = host.context;
  }

  registerApi(api: Parameters<DoomServerHostService['registerApi']>[0]) {
    const headless = this.scope === 'session' ? readDoomHeadlessHost(this.ctx) : undefined;
    if (headless) {
      let mounted: ReturnType<DoomServerHostService['registerApi']> | undefined;
      const activity = headless.registerActivity({
        name: `api:${api.basePath}`,
        start: () => {
          const registration = this.host.registerApi(api);
          if (registration.mounted !== true) {
            registration.dispose();
            throw new Error(`package API '${api.basePath}' did not mount.`);
          }
          mounted = registration;
          return () => {
            registration.dispose();
            mounted = undefined;
          };
        },
      });
      return {
        get mounted() {
          return mounted?.mounted === true;
        },
        dispose: () => activity.dispose(),
      };
    }
    const registration = this.host.registerApi(api);
    if (registration.mounted !== true) {
      registration.dispose();
      throw new Error(`package API '${api.basePath}' did not mount.`);
    }
    this.ctx.effect(() => () => registration.dispose(), 'server facet API registration');
    return registration;
  }

  registerChannel(channel: Parameters<DoomServerHostService['registerChannel']>[0]) {
    const registration = this.host.registerChannel(channel);
    if (registration.mounted !== true) {
      registration.dispose();
      throw new Error(`hub channel '${channel.frameType}' did not mount.`);
    }
    this.ctx.effect(() => () => registration.dispose(), 'server facet channel registration');
    return registration;
  }

  mounted(): readonly string[] {
    return this.host.mounted();
  }

  mountedChannels(): readonly string[] {
    return this.host.mountedChannels();
  }
}

/** Publishes the host service from inside a mounted plugin, so it unwinds with the root. */
function serverHostProvider(context: Context, host: DoomServerHostService): void {
  new ScopedDoomServerHost(context, host);
}

/**
 * Installs server facets into a cordis root that provides the server host.
 *
 * A cordis root rather than plain calls, because a facet is a Doom
 * contribution like any other: it may inject services a host provides later,
 * and it unwinds through the same fiber disposal the Pi facet uses. One root
 * per host process, created here, so no host has to know cordis to run one.
 *
 * Facets are awaited one at a time and each is a single fiber, because a
 * facet declares its `inject` on itself. `fiber.await()` therefore settles
 * once `apply` has run, and the caller can read a complete mount table before
 * deciding whether to open a listener.
 */
export async function installServerFacets(options: InstallServerFacetsOptions): Promise<InstalledServerFacets> {
  const notice = options.onNotice ?? ((): void => {});
  const root = new Context();
  await root.plugin(serverHostProvider, options.host).await();
  try {
    await options.prepare?.(root);
  } catch (error) {
    await root.fiber.dispose();
    throw error;
  }
  if (
    options.facets.some((candidate) => 'retained' in candidate && candidate.retained === true) &&
    !readDoomHeadlessHost(root)
  ) {
    await root.fiber.dispose();
    throw new Error('Retained server candidates require a gated headless host');
  }
  const installed: Fiber[] = [];
  const installedPackages: string[] = [];

  const disposeInstalled = async (): Promise<void> => {
    for (const fiber of [...installed].reverse()) await fiber.dispose();
  };

  for (const candidate of options.facets) {
    const facet = 'declaration' in candidate ? candidate.facet : candidate;
    const declaration = 'declaration' in candidate ? candidate.declaration : undefined;
    let fiber: Fiber | undefined;
    try {
      const scope = declaration ? root.extend({ [DOOM_HEADLESS_OWNER]: declaration }) : root;
      fiber = scope.plugin(facet);
      await fiber.await();
      installed.push(fiber);
      if (declaration) installedPackages.push(declaration.packageName);
    } catch (error) {
      await fiber?.dispose();
      const message = `${declaration === undefined ? 'a server facet' : `server facet '${declaration.packageName}'`} did not install (${error instanceof Error ? error.message : String(error)})`;
      if (
        declaration?.required === true &&
        !('initiallyEligible' in candidate && candidate.initiallyEligible === false)
      ) {
        await disposeInstalled();
        await root.fiber.dispose();
        throw new Error(message, { cause: error });
      }
      notice(message);
    }
  }

  let disposePromise: Promise<void> | undefined;
  return {
    root,
    installedPackages,
    dispose: () => {
      disposePromise ??= (async () => {
        await disposeInstalled();
        await root.fiber.dispose();
      })();
      return disposePromise;
    },
  };
}
