import { configScopeOf } from '../../services/configPolicy.ts';
import { globalDoomConfigPath, loadDoomConfigLayers, repositoryDoomConfigPath } from '../config.ts';
import { loadDomains } from '../domains.ts';
import { loadMajorModesConfig } from '../majorModes.ts';
import { loadProfiles } from '../profiles.ts';
import { loadPiImageSettings, savePiImageSettings } from '../piConfig.ts';
import { setDoomConfigValue, unsetDoomConfigValue, writeDoomConfigValues } from '../configWriter.ts';
import { DEFAULT_IMAGE_MAX_DIMENSION, MIN_IMAGE_MAX_DIMENSION } from '../../services/imageSettings.ts';
import { defaultDomainsForMajorMode } from '../domains.ts';
import type { DoomApi, DoomApiContext } from '@agimon-ai/doompi-extension-contracts/package-api';
import type {
  RepositoryCatalogOption,
  RepositorySelectionChanges,
  RepositorySelectionWriteRequest,
  RepositorySettingsView,
  SettingsConfigView,
  SettingsRepository,
  SettingsScope,
  SettingsValueView,
  SettingsWriteRequest,
} from '../../types/settings.ts';

const KEY_SEPARATOR = '.';

const SELECTION_KEYS = {
  majorMode: ['selection', 'majorMode'],
  domains: ['selection', 'domains'],
  profile: ['selection', 'profile'],
} as const;

type SelectionKey = keyof typeof SELECTION_KEYS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The display form of a config value; a record has no single-line form, so it has none. */
function displayValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => displayValue(entry) ?? '').join(', ');
  return undefined;
}

function pathFor(scope: SettingsScope, repoRoot: string, homeDirectory: string | undefined): string {
  return scope === 'repository' ? repositoryDoomConfigPath(repoRoot) : globalDoomConfigPath(homeDirectory);
}

function parseWrite(body: unknown): SettingsWriteRequest | undefined {
  if (!isRecord(body)) return undefined;
  const { repoRoot, scope, keyPath, value, expectedHash } = body;
  if (typeof repoRoot !== 'string') return undefined;
  if (scope !== 'global' && scope !== 'repository') return undefined;
  // Only a repository write needs to know which repository.
  if (scope === 'repository' && repoRoot === '') return undefined;
  if (!Array.isArray(keyPath) || keyPath.length === 0 || keyPath.some((part) => typeof part !== 'string')) {
    return undefined;
  }
  if (value !== null && typeof value !== 'string') return undefined;
  if (typeof expectedHash !== 'string') return undefined;
  return { repoRoot, scope, keyPath: keyPath as string[], value, expectedHash };
}

function configuredSelectionValue<T>(
  layers: ReturnType<typeof loadDoomConfigLayers>,
  key: SelectionKey,
  effective: T | undefined,
): { effective?: T; repository?: T; origin: 'global' | 'repository' | 'default' } {
  const origin = layers.originOf(SELECTION_KEYS[key]);
  return {
    ...(effective === undefined ? {} : { effective }),
    ...(origin === 'repository' && effective !== undefined ? { repository: effective } : {}),
    origin,
  };
}

function repositorySettingsView(
  repository: SettingsRepository,
  homeDirectory: string | undefined,
): RepositorySettingsView {
  const repoRoot = repository.path;
  const layers = loadDoomConfigLayers(repoRoot, homeDirectory);
  const modes = loadMajorModesConfig(repoRoot, homeDirectory);
  const domains = loadDomains(repoRoot, homeDirectory);
  const profiles = loadProfiles(repoRoot, homeDirectory);
  const configured = layers.effective.selection;
  const effectiveMajorMode = configured?.majorMode ?? modes.defaultMajorMode;
  const effectiveDomains =
    configured?.domains ?? defaultDomainsForMajorMode(effectiveMajorMode, {}, domains.defaultDomains);
  const majorModes: RepositoryCatalogOption[] = Object.entries(modes.majorMode)
    .map(([name, definition]) => ({ name, description: definition.description, layers: definition.layers }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const domainOptions: RepositoryCatalogOption[] = [
    ...Object.entries(domains.domains).map(([name, definition]) => ({
      name,
      ...(definition.description ? { description: definition.description } : {}),
    })),
    ...Object.entries(domains.aliases).map(([name, expandsTo]) => ({
      name,
      description: `Alias for ${expandsTo.join(', ') || 'no domains'}.`,
      expandsTo,
    })),
  ].sort((left, right) => left.name.localeCompare(right.name));

  return {
    repository,
    hash: layers.repositoryFile.hash,
    catalogs: {
      majorModes,
      domains: domainOptions,
      profiles: profiles.map((profile) => ({ name: profile.name })),
    },
    selection: {
      majorMode: configuredSelectionValue(layers, 'majorMode', effectiveMajorMode),
      domains: configuredSelectionValue(layers, 'domains', effectiveDomains),
      profile: configuredSelectionValue(layers, 'profile', configured?.profile),
    },
  };
}

function parseSelectionChanges(value: unknown): RepositorySelectionChanges | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !Object.hasOwn(SELECTION_KEYS, key))) return undefined;
  const changes: RepositorySelectionChanges = {};
  if (Object.hasOwn(value, 'majorMode')) {
    if (value.majorMode !== null && (typeof value.majorMode !== 'string' || value.majorMode.trim() === ''))
      return undefined;
    changes.majorMode = value.majorMode === null ? null : value.majorMode.trim();
  }
  if (Object.hasOwn(value, 'domains')) {
    if (
      value.domains !== null &&
      (!Array.isArray(value.domains) || value.domains.some((name) => typeof name !== 'string' || name.trim() === ''))
    ) {
      return undefined;
    }
    changes.domains =
      value.domains === null ? null : [...new Set((value.domains as string[]).map((name) => name.trim()))];
  }
  if (Object.hasOwn(value, 'profile')) {
    if (value.profile !== null && (typeof value.profile !== 'string' || value.profile.trim() === '')) return undefined;
    changes.profile = value.profile === null ? null : value.profile.trim();
  }
  return changes;
}

function parseSelectionWrite(value: unknown): RepositorySelectionWriteRequest | undefined {
  if (!isRecord(value) || typeof value.repositoryId !== 'string' || typeof value.expectedHash !== 'string')
    return undefined;
  const changes = parseSelectionChanges(value.changes);
  return changes === undefined
    ? undefined
    : { repositoryId: value.repositoryId, expectedHash: value.expectedHash, changes };
}

function validateSelectionChanges(
  view: RepositorySettingsView,
  changes: RepositorySelectionChanges,
): string | undefined {
  if (changes.majorMode !== undefined && changes.majorMode !== null) {
    if (!view.catalogs.majorModes.some((mode) => mode.name === changes.majorMode)) {
      return `Unknown major mode '${changes.majorMode}'.`;
    }
  }
  if (changes.domains !== undefined && changes.domains !== null) {
    const known = new Set(view.catalogs.domains.map((domain) => domain.name));
    const unknown = changes.domains.find((domain) => !known.has(domain));
    if (unknown !== undefined) return `Unknown domain '${unknown}'.`;
  }
  if (changes.profile !== undefined && changes.profile !== null) {
    if (!view.catalogs.profiles.some((profile) => profile.name === changes.profile)) {
      return `Unknown profile '${changes.profile}'.`;
    }
  }
  return undefined;
}

function selectionEdits(changes: RepositorySelectionChanges) {
  return (Object.entries(changes) as Array<[SelectionKey, string | readonly string[] | null]>).map(([key, value]) => ({
    keyPath: SELECTION_KEYS[key],
    ...(value === null ? {} : { value }),
  }));
}

function configView(context: DoomApiContext, keys: readonly string[]): SettingsConfigView {
  const root = context.scope === 'workspace' ? context.workspaceRoot : undefined;
  const layers = loadDoomConfigLayers(root, context.homeDirectory);
  const values: Record<string, SettingsValueView> = {};
  for (const key of keys) {
    const keyPath = key.split(KEY_SEPARATOR);
    const value = displayValue(layers.valueAt(keyPath));
    values[key] = {
      ...(value === undefined ? {} : { value }),
      origin: layers.originOf(keyPath),
      scope: configScopeOf(keyPath),
    };
  }
  return {
    repoRoot: root ?? '',
    values,
    hashes: { global: layers.globalFile.hash, repository: layers.repositoryFile.hash },
  };
}

/** Config handlers are bound to their mount. Request paths cannot choose a different repository. */
export const settingsApi: DoomApi = {
  basePath: 'config',
  start(context) {
    if (context.scope === 'session') throw new Error('Configuration settings require a global or workspace mount.');
    const { homeDirectory } = context;
    const repository = (): SettingsRepository | undefined =>
      context.scope === 'workspace' && context.workspaceId && context.workspaceRoot
        ? {
            id: context.workspaceId,
            name: context.workspaceRoot.split('/').at(-1) ?? context.workspaceId,
            path: context.workspaceRoot,
            active: context.repositories?.().find((entry) => entry.id === context.workspaceId)?.active ?? false,
          }
        : undefined;
    const imageView = () => ({
      ...loadPiImageSettings(homeDirectory),
      minDimension: MIN_IMAGE_MAX_DIMENSION,
      maxAllowedDimension: DEFAULT_IMAGE_MAX_DIMENSION,
    });
    let writes: Promise<unknown> = Promise.resolve();
    let closed = false;
    const dispatch = async (request: Request): Promise<Response> => {
      if (closed) return Response.json({ error: 'Configuration mount is closed.' }, { status: 503 });
      const url = new URL(request.url);
      const currentRepository = repository();
      if (url.pathname === '/config' && request.method === 'GET')
        return Response.json(configView(context, url.searchParams.getAll('key')));
      if (url.pathname === '/repositories' && request.method === 'GET')
        return Response.json({ repositories: context.repositories?.() ?? [] });
      if (url.pathname === '/repository' && request.method === 'GET') {
        return currentRepository
          ? Response.json(repositorySettingsView(currentRepository, homeDirectory))
          : Response.json({ error: 'Choose a workspace.' }, { status: 404 });
      }
      if (url.pathname === '/images' && context.scope === 'global') {
        if (request.method === 'GET') return Response.json(imageView());
        if (request.method === 'PUT') {
          const body: unknown = await request.json();
          if (
            !isRecord(body) ||
            (body.autoResize !== undefined && typeof body.autoResize !== 'boolean') ||
            (body.maxDimension !== undefined &&
              (typeof body.maxDimension !== 'number' || !Number.isFinite(body.maxDimension)))
          )
            return Response.json({ error: 'Invalid image settings.' }, { status: 400 });
          savePiImageSettings(
            {
              ...(typeof body.autoResize === 'boolean' ? { autoResize: body.autoResize } : {}),
              ...(typeof body.maxDimension === 'number' ? { maxDimension: body.maxDimension } : {}),
            },
            homeDirectory,
          );
          context.configurationChanged?.();
          return Response.json(imageView());
        }
      }
      if (url.pathname === '/repository/selection' && request.method === 'PUT') {
        const body = parseSelectionWrite(await request.json());
        if (!body)
          return Response.json({ error: 'A selection write needs typed changes and a file hash.' }, { status: 400 });
        if (!currentRepository || body.repositoryId !== currentRepository.id)
          return Response.json({ error: 'Workspace not found in this mount.' }, { status: 404 });
        const before = repositorySettingsView(currentRepository, homeDirectory);
        if (before.hash !== body.expectedHash)
          return Response.json(
            { error: 'The repository config changed since it was read.', hash: before.hash },
            { status: 409 },
          );
        const invalid = validateSelectionChanges(before, body.changes);
        if (invalid) return Response.json({ error: invalid }, { status: 422 });
        await writeDoomConfigValues(repositoryDoomConfigPath(currentRepository.path), selectionEdits(body.changes), {
          scope: 'repository',
        });
        context.configurationChanged?.();
        return Response.json(repositorySettingsView(currentRepository, homeDirectory));
      }
      if (url.pathname === '/value' && request.method === 'PUT') {
        const body = parseWrite(await request.json());
        if (!body)
          return Response.json({ error: 'A save requires a scope, key, value and file hash.' }, { status: 400 });
        const scope = context.scope === 'global' ? 'global' : 'repository';
        if (body.scope !== scope || (scope === 'repository' && body.repoRoot !== currentRepository?.path))
          return Response.json({ error: 'The write targets a different mount.' }, { status: 403 });
        const allowed = configScopeOf(body.keyPath);
        if (allowed !== 'both' && allowed !== scope)
          return Response.json({ error: 'This key cannot be set at this scope.' }, { status: 409 });
        const before = configView(context, []);
        if (before.hashes[scope] !== body.expectedHash)
          return Response.json(
            { error: 'The config changed since it was read.', hash: before.hashes[scope] },
            { status: 409 },
          );
        const target = pathFor(scope, currentRepository?.path ?? '', homeDirectory);
        if (body.value === null) await unsetDoomConfigValue(target, body.keyPath, { scope });
        else await setDoomConfigValue(target, body.keyPath, body.value, { scope });
        context.configurationChanged?.();
        return Response.json(configView(context, [body.keyPath.join(KEY_SEPARATOR)]));
      }
      return Response.json({ error: 'Configuration route not found.' }, { status: 404 });
    };
    const guarded = async (request: Request): Promise<Response> => {
      try {
        return await dispatch(request);
      } catch (error) {
        return Response.json({ error: describe(error) }, { status: error instanceof SyntaxError ? 400 : 422 });
      }
    };
    return {
      fetch(request) {
        if (request.method === 'GET' || request.method === 'HEAD') return guarded(request);
        const result = writes.then(() => guarded(request));
        writes = result.catch(() => undefined);
        return result;
      },
      close() {
        closed = true;
      },
    };
  },
};
