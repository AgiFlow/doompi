import type { DoomApiContext } from '@agimon-ai/doompi-core/package-api';

import { KEY_SEPARATOR, SELECTION_KEYS } from '../../constants/settings';
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
} from '../../types/settings';
import { globalDoomConfigPath, loadDoomConfigLayers, repositoryDoomConfigPath } from '../config';
import { configScopeOf } from '../configPolicy';
import { defaultDomainsForMajorMode, loadDomains } from '../domains';
import { loadMajorModesConfig } from '../majorModes';
import { loadProfiles } from '../profiles';

type SelectionKey = keyof typeof SELECTION_KEYS;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The display form of a config value; a record has no single-line form, so it has none. */
export function displayValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => displayValue(entry) ?? '').join(', ');
  return undefined;
}

export function pathFor(scope: SettingsScope, repoRoot: string, homeDirectory: string | undefined): string {
  return scope === 'repository' ? repositoryDoomConfigPath(repoRoot) : globalDoomConfigPath(homeDirectory);
}

export function parseWrite(body: unknown): SettingsWriteRequest | undefined {
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

export function configuredSelectionValue<T>(
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

export function repositorySettingsView(
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

export function parseSelectionChanges(value: unknown): RepositorySelectionChanges | undefined {
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

export function parseSelectionWrite(value: unknown): RepositorySelectionWriteRequest | undefined {
  if (!isRecord(value) || typeof value.repositoryId !== 'string' || typeof value.expectedHash !== 'string')
    return undefined;
  const changes = parseSelectionChanges(value.changes);
  return changes === undefined
    ? undefined
    : { repositoryId: value.repositoryId, expectedHash: value.expectedHash, changes };
}

export function validateSelectionChanges(
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

export function selectionEdits(changes: RepositorySelectionChanges) {
  return (Object.entries(changes) as Array<[SelectionKey, string | readonly string[] | null]>).map(([key, value]) => ({
    keyPath: SELECTION_KEYS[key],
    ...(value === null ? {} : { value }),
  }));
}

export function configView(context: DoomApiContext, keys: readonly string[]): SettingsConfigView {
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
