import type { DoomApiScope } from './packageApi.ts';

export const DOOM_SERVER_BUNDLE_VERSION = 2;
export const DOOM_SERVER_BUNDLE_FILE = 'server.bundle.json';

/** Every occurrence that can activate a package in this repository. */
export interface DoomServerBundleOwner {
  readonly majorMode: string;
  readonly layer: string;
}

export interface DoomServerBundleEntry {
  readonly packageName: string;
  /** The declared package-relative source entry, retained for attribution. */
  readonly entry: string;
  /** Generation-local built module, relative to the descriptor directory. */
  readonly module: string;
  readonly scopes: readonly DoomApiScope[];
  readonly owners: readonly DoomServerBundleOwner[];
  readonly required: boolean;
}

/** Ordered candidates, never an instruction to activate every package. */
export interface DoomServerBundle {
  readonly version: typeof DOOM_SERVER_BUNDLE_VERSION;
  readonly generation: string;
  readonly fingerprint: string;
  readonly entries: readonly DoomServerBundleEntry[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(`Invalid server bundle ${field}`);
  }
  return value;
}

function relativeFile(value: unknown, field: string): string {
  const file = text(value, field);
  const segments = file.slice(2).split('/');
  if (
    !file.startsWith('./') ||
    /[\\%?#]/u.test(file) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid server bundle ${field}: expected a contained ./file path`);
  }
  return file;
}

/** Validate the entire descriptor before any package code is imported. */
export function parseDoomServerBundle(value: unknown): DoomServerBundle {
  if (!record(value) || value.version !== DOOM_SERVER_BUNDLE_VERSION) {
    throw new Error('Unsupported server bundle version');
  }
  const generation = text(value.generation, 'generation');
  const fingerprint = text(value.fingerprint, 'fingerprint');
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('Invalid server bundle fingerprint');
  if (!Array.isArray(value.entries)) throw new Error('Invalid server bundle entries');
  const names = new Set<string>();
  const entries = value.entries.map((candidate: unknown): DoomServerBundleEntry => {
    if (!record(candidate)) throw new Error('Invalid server bundle entry');
    const packageName = text(candidate.packageName, 'packageName');
    if (names.has(packageName)) throw new Error(`Duplicate server bundle package: ${packageName}`);
    names.add(packageName);
    const entry = relativeFile(candidate.entry, `${packageName} entry`);
    const module = relativeFile(candidate.module, `${packageName} module`);
    if (!module.endsWith('.mjs')) throw new Error(`Invalid server bundle ${packageName} module: expected .mjs`);
    if (
      !Array.isArray(candidate.scopes) ||
      candidate.scopes.length === 0 ||
      candidate.scopes.some((scope) => scope !== 'session' && scope !== 'global' && scope !== 'workspace') ||
      new Set(candidate.scopes).size !== candidate.scopes.length
    ) {
      throw new Error(`Invalid server bundle ${packageName} scopes`);
    }
    if (!Array.isArray(candidate.owners) || candidate.owners.length === 0) {
      throw new Error(`Invalid server bundle ${packageName} owners`);
    }
    const ownership = new Set<string>();
    const owners = candidate.owners.map((owner: unknown): DoomServerBundleOwner => {
      if (!record(owner)) throw new Error(`Invalid server bundle ${packageName} owner`);
      const majorMode = text(owner.majorMode, `${packageName} majorMode`);
      const layer = text(owner.layer, `${packageName} layer`);
      const key = JSON.stringify([majorMode, layer]);
      if (ownership.has(key)) throw new Error(`Duplicate server bundle ${packageName} owner`);
      ownership.add(key);
      return { majorMode, layer };
    });
    if (typeof candidate.required !== 'boolean') throw new Error(`Invalid server bundle ${packageName} required`);
    return { packageName, entry, module, scopes: candidate.scopes, owners, required: candidate.required };
  });
  return { version: DOOM_SERVER_BUNDLE_VERSION, generation, fingerprint, entries };
}
