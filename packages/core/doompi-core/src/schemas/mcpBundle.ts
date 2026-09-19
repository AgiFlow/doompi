import type { DoomServerBundleOwner } from './serverBundle';

export const DOOM_MCP_BUNDLE_VERSION = 1;
export const DOOM_MCP_BUNDLE_FILE = 'mcp.bundle.json';

export interface DoomMcpBundleEntry {
  readonly packageName: string;
  readonly entry: string;
  readonly module: string;
  readonly sha256: string;
  readonly owners: readonly DoomServerBundleOwner[];
}

export interface DoomMcpBundle {
  readonly version: typeof DOOM_MCP_BUNDLE_VERSION;
  readonly generation: string;
  readonly fingerprint: string;
  readonly entries: readonly DoomMcpBundleEntry[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0'))
    throw new Error(`Invalid MCP bundle ${field}`);
  return value;
}

function relativeFile(value: unknown, field: string): string {
  const file = text(value, field);
  const segments = file.slice(2).split('/');
  if (
    !file.startsWith('./') ||
    /[\\%?#]/u.test(file) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new Error(`Invalid MCP bundle ${field}: expected a contained ./file path`);
  return file;
}

/** Validates the admitted descriptor before importing any package code. */
export function parseDoomMcpBundle(value: unknown): DoomMcpBundle {
  if (!record(value) || value.version !== DOOM_MCP_BUNDLE_VERSION) throw new Error('Unsupported MCP bundle version');
  const generation = text(value.generation, 'generation');
  const fingerprint = text(value.fingerprint, 'fingerprint');
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('Invalid MCP bundle fingerprint');
  if (!Array.isArray(value.entries)) throw new Error('Invalid MCP bundle entries');
  const names = new Set<string>();
  const entries = value.entries.map((candidate: unknown): DoomMcpBundleEntry => {
    if (!record(candidate)) throw new Error('Invalid MCP bundle entry');
    const packageName = text(candidate.packageName, 'packageName');
    if (names.has(packageName)) throw new Error(`Duplicate MCP bundle package: ${packageName}`);
    names.add(packageName);
    const entry = relativeFile(candidate.entry, `${packageName} entry`);
    const module = relativeFile(candidate.module, `${packageName} module`);
    if (!module.endsWith('.mjs')) throw new Error(`Invalid MCP bundle ${packageName} module: expected .mjs`);
    const sha256 = text(candidate.sha256, `${packageName} sha256`);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`Invalid MCP bundle ${packageName} sha256`);
    if (!Array.isArray(candidate.owners) || candidate.owners.length === 0)
      throw new Error(`Invalid MCP bundle ${packageName} owners`);
    const ownership = new Set<string>();
    const owners = candidate.owners.map((owner: unknown): DoomServerBundleOwner => {
      if (!record(owner)) throw new Error(`Invalid MCP bundle ${packageName} owner`);
      const majorMode = text(owner.majorMode, `${packageName} majorMode`);
      const layer = text(owner.layer, `${packageName} layer`);
      const key = JSON.stringify([majorMode, layer]);
      if (ownership.has(key)) throw new Error(`Duplicate MCP bundle ${packageName} owner`);
      ownership.add(key);
      return { majorMode, layer };
    });
    return { packageName, entry, module, sha256, owners };
  });
  return { version: DOOM_MCP_BUNDLE_VERSION, generation, fingerprint, entries };
}
