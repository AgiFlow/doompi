import {
  configScopeOf,
  DEFAULT_IMAGE_MAX_DIMENSION,
  globalDoomConfigPath,
  loadDomains,
  loadDoomConfigLayers,
  loadMajorModesConfig,
  loadPiImageSettings,
  loadProfiles,
  MIN_IMAGE_MAX_DIMENSION,
  repositoryDoomConfigPath,
  savePiImageSettings,
  setDoomConfigValue,
  unsetDoomConfigValue,
  writeDoomConfigValues,
  type PiImageSettings,
} from '@agimon-ai/doompi-config';
import { defaultDomainsForMajorMode } from '@agimon-ai/doompi-config/domains';
import type { Hono } from 'hono';
import {
  SETTINGS_CONFIG_API_ROUTE,
  SETTINGS_MODELS_API_ROUTE,
  SETTINGS_REPOSITORIES_API_ROUTE,
  SETTINGS_REPOSITORY_API_ROUTE,
  SETTINGS_IMAGES_API_ROUTE,
  SETTINGS_REPOSITORY_SELECTION_API_ROUTE,
  SETTINGS_VALUE_API_ROUTE,
  type RepositoryCatalogOption,
  type RepositorySelectionChanges,
  type RepositorySelectionWriteRequest,
  type RepositorySettingsView,
  type SettingsConfigView,
  type SettingsImagesView,
  type SettingsModel,
  type SettingsRepository,
  type SettingsScope,
  type SettingsValueView,
  type SettingsWriteRequest,
} from '../types/settings.ts';

/**
 * The settings REST surface: read the two config files apart, and write one key
 * into whichever the reader chose.
 *
 * These are host routes rather than a package API because the page is not
 * scoped to a session. It names a repository, and only the hub can turn that
 * into a file path and answer for a machine with no session running at all.
 *
 * The one rule worth stating: a write is refused when the key's scope does not
 * accept it. `editor` is read from the global file whatever a repository says,
 * and `projectTrust` from the repository file whatever the global one says, so
 * writing either to the wrong file would land bytes on disk that the merge then
 * ignores. Silently doing nothing is the worst available outcome, so it is an
 * error with the reason instead.
 */

const KEY_SEPARATOR = '.';

export interface SettingsRoutesOptions {
  /** Repositories the picker offers; the hub supplies its sessions' working directories. */
  repositories: () => readonly SettingsRepository[];
  /** Models the machine can use, for fields declaring optionsFrom: 'models'. */
  models: () => Promise<readonly SettingsModel[]>;
  /** Test seam; defaults to the real home directory. */
  homeDirectory?: string;
}

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

/** The repository to read against, or undefined when the page has none in view. */
function repositoryOf(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
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

function repositoryById(options: SettingsRoutesOptions, repositoryId: string): SettingsRepository | undefined {
  return options.repositories().find((repository) => repository.id === repositoryId);
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

export function registerSettingsRoutes(app: Hono, options: SettingsRoutesOptions): void {
  const { homeDirectory } = options;

  app.get(SETTINGS_REPOSITORIES_API_ROUTE, (context) => context.json({ repositories: options.repositories() }));

  app.get(SETTINGS_REPOSITORY_API_ROUTE, (context) => {
    const repositoryId = context.req.query('repository');
    const repository = repositoryId === undefined ? undefined : repositoryById(options, repositoryId);
    if (repository === undefined) return context.json({ error: 'Choose a repository the hub knows about.' }, 404);
    try {
      return context.json(repositorySettingsView(repository, homeDirectory));
    } catch (error) {
      return context.json({ error: describe(error) }, 422);
    }
  });

  app.put(SETTINGS_REPOSITORY_SELECTION_API_ROUTE, async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    const request = parseSelectionWrite(body);
    if (request === undefined) {
      return context.json({ error: 'A selection write needs a repository, file hash, and typed changes.' }, 400);
    }
    const repository = repositoryById(options, request.repositoryId);
    if (repository === undefined) return context.json({ error: 'Choose a repository the hub knows about.' }, 404);

    let before: RepositorySettingsView;
    try {
      before = repositorySettingsView(repository, homeDirectory);
    } catch (error) {
      return context.json({ error: describe(error) }, 422);
    }
    if (before.hash !== request.expectedHash) {
      return context.json({ error: 'The repository config changed since it was read.', hash: before.hash }, 409);
    }
    const invalid = validateSelectionChanges(before, request.changes);
    if (invalid !== undefined) return context.json({ error: invalid }, 422);

    try {
      await writeDoomConfigValues(repositoryDoomConfigPath(repository.path), selectionEdits(request.changes), {
        scope: 'repository',
      });
      return context.json(repositorySettingsView(repository, homeDirectory));
    } catch (error) {
      return context.json({ error: describe(error) }, 422);
    }
  });

  app.get(SETTINGS_MODELS_API_ROUTE, async (context) => {
    try {
      return context.json({ models: await options.models() });
    } catch (error) {
      // A machine without a usable Pi install still gets a settings page; the
      // model fields fall back to free text rather than the page failing.
      return context.json({ error: `Models are unavailable: ${describe(error)}` }, 502);
    }
  });

  // The image limits are Pi's own settings.json rather than the Doom config, so
  // they get a route of their own: one file, no repository scope, and Pi's TUI
  // toggle writing the same key.
  const imagesView = (settings: PiImageSettings): SettingsImagesView => ({
    ...settings,
    minDimension: MIN_IMAGE_MAX_DIMENSION,
    maxAllowedDimension: DEFAULT_IMAGE_MAX_DIMENSION,
  });

  app.get(SETTINGS_IMAGES_API_ROUTE, (context) => {
    try {
      return context.json(imagesView(loadPiImageSettings(homeDirectory)));
    } catch (error) {
      // An unparseable settings.json is what a reader opens this page to fix.
      return context.json({ error: describe(error) }, 422);
    }
  });

  app.put(SETTINGS_IMAGES_API_ROUTE, async (context) => {
    const request: unknown = await context.req.json().catch(() => undefined);
    if (!isRecord(request)) return context.json({ error: 'An image settings write needs a JSON body.' }, 400);
    const { autoResize, maxDimension } = request;
    if (autoResize !== undefined && typeof autoResize !== 'boolean') {
      return context.json({ error: 'autoResize is true or false.' }, 400);
    }
    if (maxDimension !== undefined && (typeof maxDimension !== 'number' || !Number.isFinite(maxDimension))) {
      return context.json({ error: 'maxDimension is a number of pixels.' }, 400);
    }
    try {
      return context.json(
        imagesView(
          savePiImageSettings(
            {
              ...(autoResize === undefined ? {} : { autoResize }),
              ...(maxDimension === undefined ? {} : { maxDimension }),
            },
            homeDirectory,
          ),
        ),
      );
    } catch (error) {
      return context.json({ error: describe(error) }, 422);
    }
  });
  app.get(SETTINGS_CONFIG_API_ROUTE, (context) => {
    // A page with no repository in view still has global settings to show, so
    // the repository is optional rather than required.
    const repoRoot = repositoryOf(context.req.query('repoRoot'));
    const keys = (context.req.queries('key') ?? []).filter((key) => key !== '');
    let layers: ReturnType<typeof loadDoomConfigLayers>;
    try {
      layers = loadDoomConfigLayers(repoRoot, homeDirectory);
    } catch (error) {
      // A malformed file is exactly what someone opens this page to repair, so
      // it has to be reported rather than hidden behind a blank page.
      return context.json({ error: describe(error) }, 422);
    }
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
    return context.json({
      repoRoot: repoRoot ?? '',
      values,
      hashes: { global: layers.globalFile.hash, repository: layers.repositoryFile.hash },
    } satisfies SettingsConfigView);
  });

  app.put(SETTINGS_VALUE_API_ROUTE, async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'The save body is not JSON.' }, 400);
    }
    const request = parseWrite(body);
    if (request === undefined) {
      return context.json({ error: 'A save names a repository, a scope, a key path, and the hash it read.' }, 400);
    }

    const allowed = configScopeOf(request.keyPath);
    if (allowed !== 'both' && allowed !== request.scope) {
      const where = allowed === 'global' ? 'the global config' : "this repository's config";
      return context.json(
        { error: `${request.keyPath.join(KEY_SEPARATOR)} is only read from ${where}, so it cannot be set here.` },
        409,
      );
    }

    const repository = repositoryOf(request.repoRoot);
    let layers: ReturnType<typeof loadDoomConfigLayers>;
    try {
      layers = loadDoomConfigLayers(repository, homeDirectory);
    } catch (error) {
      return context.json({ error: describe(error) }, 422);
    }
    const current = request.scope === 'global' ? layers.globalFile.hash : layers.repositoryFile.hash;
    if (current !== request.expectedHash) {
      return context.json({ error: 'The config changed since it was read.', hash: current }, 409);
    }

    const filePath = pathFor(request.scope, request.repoRoot, homeDirectory);
    try {
      if (request.value === null) {
        await unsetDoomConfigValue(filePath, request.keyPath, { scope: request.scope });
      } else {
        await setDoomConfigValue(filePath, request.keyPath, request.value, { scope: request.scope });
      }
    } catch (error) {
      // The writer validates the whole file before publishing it, so a rejected
      // value reaches here having written nothing.
      return context.json({ error: describe(error) }, 422);
    }

    const written = loadDoomConfigLayers(repository, homeDirectory);
    return context.json({
      repoRoot: repository ?? '',
      values: {
        [request.keyPath.join(KEY_SEPARATOR)]: {
          ...(displayValue(written.valueAt(request.keyPath)) === undefined
            ? {}
            : { value: displayValue(written.valueAt(request.keyPath))! }),
          origin: written.originOf(request.keyPath),
          scope: allowed,
        },
      },
      hashes: { global: written.globalFile.hash, repository: written.repositoryFile.hash },
    } satisfies SettingsConfigView);
  });
}
