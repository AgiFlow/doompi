/**
 * The settings REST surface, as both halves see it.
 *
 * Settings are host routes rather than a package API because the page is not
 * scoped to a session: it names a repository instead, and a plugin's browser
 * code may not reach the hub's own client helpers. The host reads and writes
 * the config file on everyone's behalf and hands each contributed field the
 * result through props.
 */
import type { RepositorySettingsRepository } from '@agimon-ai/doompi-web-contracts';

export const SETTINGS_CONFIG_API_ROUTE = '/api/settings/config';
export const SETTINGS_VALUE_API_ROUTE = '/api/settings/value';
export const SETTINGS_REPOSITORIES_API_ROUTE = '/api/settings/repositories';
export const SETTINGS_MODELS_API_ROUTE = '/api/settings/models';
export const SETTINGS_REPOSITORY_API_ROUTE = '/api/settings/repository';
export const SETTINGS_REPOSITORY_SELECTION_API_ROUTE = '/api/settings/repository/selection';

/** Which of the two config files a read or write is about. */
export type SettingsScope = 'global' | 'repository';

/** Where the effective value came from, or that no file set it. */
export type SettingsOrigin = 'global' | 'repository' | 'default';

/** Which scopes a key may be written at, as the merge policy decides. */
export type SettingsKeyScope = 'global' | 'repository' | 'both';

/** One repository the picker offers. */
export type SettingsRepository = RepositorySettingsRepository;

/** One model the machine can actually use, for a field declaring optionsFrom: 'models'. */
export interface SettingsModel {
  /** `provider/model-id`, which is what the config file holds. */
  value: string;
  label: string;
  group: string;
}

/** One key's current state, keyed by its dotted path. */
export interface SettingsValueView {
  /** The effective value, stringified for display; absent when nothing set it. */
  value?: string;
  origin: SettingsOrigin;
  /** Which scopes may hold this key. A field outside the chosen scope is read-only. */
  scope: SettingsKeyScope;
}

/** What the read route answers with. */
export interface SettingsConfigView {
  /** Empty when the page has no repository in view; the global half still applies. */
  repoRoot: string;
  /** Keyed by dotted key path, for every key the page asked about. */
  values: Record<string, SettingsValueView>;
  /** Per-scope file identity, so a write can prove which bytes it read. */
  hashes: Record<SettingsScope, string>;
}

/** What the write route takes. `value: null` clears the key at that scope. */
export interface SettingsWriteRequest {
  /** Required for a repository write; ignored, and may be empty, for a global one. */
  repoRoot: string;
  scope: SettingsScope;
  keyPath: readonly string[];
  value: string | null;
  /** The hash of the target file when the page read it. */
  expectedHash: string;
}

/** A named option from one effective repository catalog. */
export interface RepositoryCatalogOption {
  name: string;
  description?: string;
  /** Present for a domain alias, naming the entries it expands to. */
  expandsTo?: readonly string[];
  /** Present for a major mode, naming its ordered layers. */
  layers?: readonly string[];
}

/** One selection axis, keeping an inherited effective value apart from this repository's override. */
export interface RepositorySelectionValue<T> {
  effective?: T;
  repository?: T;
  origin: SettingsOrigin;
}

/** The repository control plane's safe, non-secret catalog and selection view. */
export interface RepositorySettingsView {
  repository: SettingsRepository;
  hash: string;
  catalogs: {
    majorModes: readonly RepositoryCatalogOption[];
    domains: readonly RepositoryCatalogOption[];
    profiles: readonly RepositoryCatalogOption[];
  };
  selection: {
    majorMode: RepositorySelectionValue<string>;
    domains: RepositorySelectionValue<readonly string[]>;
    profile: RepositorySelectionValue<string>;
  };
}

export interface RepositorySelectionChanges {
  majorMode?: string | null;
  domains?: readonly string[] | null;
  profile?: string | null;
}

/** An optimistic, atomic write into one repository's selection defaults. */
export interface RepositorySelectionWriteRequest {
  repositoryId: string;
  expectedHash: string;
  changes: RepositorySelectionChanges;
}

/** What a route reports when it refuses; the page shows `error` verbatim. */
export interface SettingsErrorView {
  error: string;
  /** On a stale write, the hash the target file actually holds now. */
  hash?: string;
}
