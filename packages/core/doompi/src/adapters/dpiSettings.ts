import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SettingsManager, SettingsManagerCreateOptions } from '@earendil-works/pi-coding-agent';
import { piCliPath } from './modules/moduleResolution.ts';
import { piAgentDirectory } from './piSettings.ts';
import { findRepositoryRoot } from './repository/repository.ts';
import { readSyncRegistration } from './syncRegistration.ts';

const GLOBAL_SCOPE = 'global';
const PROJECT_SCOPE = 'project';
const MANAGED_KEYS = ['extensions', 'themes', 'theme', 'quietStartup'] as const;

export interface DpiManagedSettings {
  extensions: string[];
  themes: string[];
  theme: string;
  quietStartup: boolean;
}

export const DPI_MANAGED_SETTINGS: DpiManagedSettings = {
  extensions: ['@agimon-ai/doompi', '!extensions/**'],
  themes: ['themes/doom-pi-dark.json'],
  theme: 'doom-pi-dark',
  quietStartup: true,
};

export type DpiSettingsScope = typeof GLOBAL_SCOPE | typeof PROJECT_SCOPE;

export interface DpiSettingsStorageBackend {
  withLock(scope: DpiSettingsScope, callback: (current: string | undefined) => string | undefined): void;
}

interface SettingsManagerClass {
  create(this: void, cwd: string, agentDir?: string, options?: SettingsManagerCreateOptions): SettingsManager;
  fromStorage(this: void, storage: DpiSettingsStorageBackend, options?: SettingsManagerCreateOptions): SettingsManager;
}

interface FileSettingsStorageConstructor {
  new (cwd: string, agentDir: string): DpiSettingsStorageBackend;
}

export interface PiSettingsRuntime {
  FileSettingsStorage: FileSettingsStorageConstructor;
  SettingsManager: SettingsManagerClass;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSettings(content: string | undefined): Record<string, unknown> {
  if (content === undefined) return {};
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new SyntaxError('Pi settings must contain a JSON object');
  return parsed;
}

function managedView(
  scope: DpiSettingsScope,
  current: string | undefined,
  managedSettings: DpiManagedSettings,
): string | undefined {
  if (scope === PROJECT_SCOPE && current === undefined) return undefined;
  const settings = parseSettings(current);
  if (scope === GLOBAL_SCOPE) Object.assign(settings, managedSettings);
  else for (const key of MANAGED_KEYS) delete settings[key];
  return JSON.stringify(settings, null, 2);
}

function restorePersistedSettings(current: string | undefined, next: string): string {
  const persisted = parseSettings(current);
  const updated = parseSettings(next);
  for (const key of MANAGED_KEYS) {
    if (Object.hasOwn(persisted, key)) updated[key] = persisted[key];
    else delete updated[key];
  }
  return JSON.stringify(updated, null, 2);
}

/**
 * Presents DoomPi-owned settings to Pi without allowing that overlay to leak
 * into either the global or project settings file when Pi saves another key.
 */
export class DpiSettingsStorage implements DpiSettingsStorageBackend {
  private readonly backend: DpiSettingsStorageBackend;
  private readonly managedSettings: DpiManagedSettings;

  constructor(backend: DpiSettingsStorageBackend, managedSettings: DpiManagedSettings = DPI_MANAGED_SETTINGS) {
    this.backend = backend;
    this.managedSettings = managedSettings;
  }

  withLock(scope: DpiSettingsScope, callback: (current: string | undefined) => string | undefined): void {
    this.backend.withLock(scope, (current) => {
      const next = callback(managedView(scope, current, this.managedSettings));
      return next === undefined ? undefined : restorePersistedSettings(current, next);
    });
  }
}

function isPiSettingsRuntime(value: unknown): value is PiSettingsRuntime {
  if (!isRecord(value) || typeof value.FileSettingsStorage !== 'function') return false;
  const settingsManager = value.SettingsManager;
  if (typeof settingsManager !== 'function') return false;
  return (
    typeof Reflect.get(settingsManager, 'create') === 'function' &&
    typeof Reflect.get(settingsManager, 'fromStorage') === 'function'
  );
}

/** Loads Pi's concrete file storage from the same pinned installation as its CLI. */
export async function loadPiSettingsRuntime(): Promise<PiSettingsRuntime> {
  const modulePath = path.join(path.dirname(piCliPath()), 'core', 'settings-manager.js');
  const loaded: unknown = await import(pathToFileURL(modulePath).href);
  if (!isPiSettingsRuntime(loaded)) throw new Error(`Unsupported Pi settings runtime: ${modulePath}`);
  return loaded;
}

/** Selects the package recorded by sync so embedded DPI does not depend on init's global dispatcher. */
export function resolveDpiManagedSettings(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): DpiManagedSettings {
  try {
    const root = findRepositoryRoot(cwd);
    const homeDirectory = environment.HOME?.trim() || os.homedir();
    const registration = readSyncRegistration(root, homeDirectory);
    if (!registration) return DPI_MANAGED_SETTINGS;
    return { ...DPI_MANAGED_SETTINGS, extensions: [registration.package.root, '!extensions/**'] };
  } catch {
    return { ...DPI_MANAGED_SETTINGS, extensions: ['!extensions/**'] };
  }
}

/** Installs the process-local create() hook used by upstream Pi startup and reloads. */
export function installDpiSettingsOverlay(
  runtime: PiSettingsRuntime,
  environment: NodeJS.ProcessEnv = process.env,
): () => void {
  const originalCreate = runtime.SettingsManager.create;
  runtime.SettingsManager.create = (cwd, agentDir, options) => {
    const resolvedAgentDirectory = agentDir ?? piAgentDirectory(environment);
    const storage = new runtime.FileSettingsStorage(cwd, resolvedAgentDirectory);
    const managedSettings = resolveDpiManagedSettings(cwd, environment);
    return runtime.SettingsManager.fromStorage(new DpiSettingsStorage(storage, managedSettings), options);
  };

  return () => {
    runtime.SettingsManager.create = originalCreate;
  };
}
