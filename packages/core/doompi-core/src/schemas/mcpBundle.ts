import type { DoomServerBundleOwner } from './serverBundle';

export const DOOM_MCP_BUNDLE_VERSION = 1;
export const DOOM_MCP_BUNDLE_FILE = 'mcp.bundle.json';

export interface DoomMcpBundleEntry {
  readonly packageName: string;
  readonly entry: string;
  readonly module: string;
  readonly sha256: string;
  readonly owners: readonly DoomServerBundleOwner[];
  /** Package-owned component keys generated from frontend tool declarations. */
  readonly widgets?: readonly string[];
}

export interface DoomMcpUiBundle {
  readonly file: string;
  readonly sha256: string;
  /** Build inputs are checked for sync freshness, never exposed in the UI resource. */
  readonly inputs: readonly { readonly path: string; readonly sha256: string }[];
}

export interface DoomMcpBundle {
  readonly version: typeof DOOM_MCP_BUNDLE_VERSION;
  readonly generation: string;
  readonly fingerprint: string;
  readonly entries: readonly DoomMcpBundleEntry[];
  readonly ui?: DoomMcpUiBundle;
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
    const widgets = candidate.widgets;
    if (
      widgets !== undefined &&
      (!Array.isArray(widgets) ||
        widgets.some(
          (key: unknown) =>
            typeof key !== 'string' ||
            !key.startsWith(`${packageName}/`) ||
            key.length <= packageName.length + 1 ||
            key.includes('\0'),
        ) ||
        new Set(widgets).size !== widgets.length)
    )
      throw new Error(`Invalid MCP bundle ${packageName} widgets`);
    return {
      packageName,
      entry,
      module,
      sha256,
      owners,
      ...(widgets === undefined ? {} : { widgets: widgets as string[] }),
    };
  });
  let ui: DoomMcpUiBundle | undefined;
  if (value.ui !== undefined) {
    if (
      !record(value.ui) ||
      typeof value.ui.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.ui.sha256) ||
      !Array.isArray(value.ui.inputs)
    )
      throw new Error('Invalid MCP UI bundle');
    const file = relativeFile(value.ui.file, 'UI file');
    if (!file.endsWith('.html')) throw new Error('Invalid MCP UI bundle file');
    const inputs = value.ui.inputs.map((input: unknown) => {
      if (!record(input) || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sha256))
        throw new Error('Invalid MCP UI input');
      return { path: text(input.path, 'UI input path'), sha256: input.sha256 };
    });
    ui = { file, sha256: value.ui.sha256, inputs };
  }
  if (entries.some((entry) => (entry.widgets?.length ?? 0) > 0) && ui === undefined)
    throw new Error('Missing composed MCP UI resource');
  return { version: DOOM_MCP_BUNDLE_VERSION, generation, fingerprint, entries, ...(ui === undefined ? {} : { ui }) };
}
