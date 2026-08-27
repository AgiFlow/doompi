import {
  configScopeOf,
  globalDoomConfigPath,
  loadDoomConfigLayers,
  repositoryDoomConfigPath,
  setDoomConfigValue,
  unsetDoomConfigValue,
} from '@agimon-ai/doompi-config';
import type { Hono } from 'hono';
import {
  SETTINGS_CONFIG_API_ROUTE,
  SETTINGS_MODELS_API_ROUTE,
  SETTINGS_REPOSITORIES_API_ROUTE,
  SETTINGS_VALUE_API_ROUTE,
  type SettingsConfigView,
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

export function registerSettingsRoutes(app: Hono, options: SettingsRoutesOptions): void {
  const { homeDirectory } = options;

  app.get(SETTINGS_REPOSITORIES_API_ROUTE, (context) => context.json({ repositories: options.repositories() }));

  app.get(SETTINGS_MODELS_API_ROUTE, async (context) => {
    try {
      return context.json({ models: await options.models() });
    } catch (error) {
      // A machine without a usable Pi install still gets a settings page; the
      // model fields fall back to free text rather than the page failing.
      return context.json({ error: `Models are unavailable: ${describe(error)}` }, 502);
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
