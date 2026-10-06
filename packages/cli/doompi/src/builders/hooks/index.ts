import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { doomConfigCandidates } from '@agimon-ai/doompi-config/layeredConfig';
import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { optionalPackageEntry } from '@agimon-ai/doompi-core/moduleResolution';
import { isRecord } from '@agimon-ai/doompi-core/runtimeJson';
import { parse as parseYaml } from 'yaml';

import { compileExtensionModule, extensionModuleManifestPath } from '../../compiler';

export const HOOK_MODULES_FILE = 'hook-modules.json';

/** Add checkout source names while retaining the admitted generation's artifact mappings. */
export function checkoutHookDescriptor(
  descriptor: { file: string } | undefined,
  sourceRoot: string,
  repoRoot: string,
  directory: string,
): { file: string } | undefined {
  if (!descriptor || path.resolve(sourceRoot) === path.resolve(repoRoot)) return descriptor;
  const value: unknown = JSON.parse(fs.readFileSync(descriptor.file, 'utf8'));
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.modules))
    throw new Error('invalid hook module descriptor');
  const sources = new Set<string>();
  const modules: Array<Record<string, unknown> & { source: string; artifact: string }> = [];
  // Validate all originals first. Never repair an invalid descriptor by dropping entries.
  for (const entry of value.modules) {
    if (
      !isRecord(entry) ||
      typeof entry.source !== 'string' ||
      typeof entry.artifact !== 'string' ||
      !path.isAbsolute(entry.source) ||
      !path.isAbsolute(entry.artifact) ||
      !['.mjs', '.js', '.cjs'].includes(path.extname(entry.artifact)) ||
      sources.has(entry.source)
    )
      throw new Error('invalid hook module artifact mapping');
    sources.add(entry.source);
    modules.push({ ...entry, source: entry.source, artifact: entry.artifact });
  }
  const aliases = [];
  for (const entry of modules) {
    const relative = path.relative(sourceRoot, entry.source);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const source = path.resolve(repoRoot, relative);
    if (sources.has(source)) continue;
    sources.add(source);
    aliases.push({ ...entry, source });
  }
  if (aliases.length === 0) return descriptor;
  const file = path.join(directory, HOOK_MODULES_FILE);
  fs.writeFileSync(file, `${JSON.stringify({ ...value, modules: [...modules, ...aliases] }, null, 2)}\n`, {
    mode: 0o600,
  });
  return { file };
}

interface HookRegistryRow {
  module?: string;
  core: boolean;
  skipInSubagent?: boolean;
  registryId: string;
  groupId: string;
  rowId: string;
  event: string;
}

/** The optional hook package owns parsing; the CLI only consumes this capability. */
interface HookParserModule {
  createHookModules(options: { descriptor?: { file: string } }): {
    validate(rows: readonly HookRegistryRow[]): Promise<void>;
    dispose(): Promise<void>;
  };
  createHookDocumentReader(options: { homeDirectory: string; warn: (message: string) => void }): {
    registry(repoRoot: string): Promise<{
      entries: HookRegistryRow[];
      failure?: { message: string };
    }>;
  };
}

/** Core plus the union of every mode's selection. An unset selection admits all. */
export function requiredHookGroups(config: MajorModesConfig): Set<string> | undefined {
  const groups = new Set<string>();
  for (const mode of Object.values(config.majorMode)) {
    const layers = mode.layers.map((name) => config.layers[name]);
    if (layers.length === 0 || layers.some((layer) => layer?.hookGroups === undefined)) return undefined;
    for (const layer of layers) for (const group of layer.hookGroups ?? []) groups.add(group);
  }
  return groups;
}

async function hookParser(options: { repoRoot: string; homeDirectory: string }): Promise<HookParserModule | undefined> {
  const candidates = doomConfigCandidates('hooks.yaml', options.repoRoot, options.homeDirectory);
  // Command-only registries predate module compilation and do not require the package.
  // This is discovery only. The public parser still owns validation and attribution.
  const hasModuleRows = candidates.some((candidate) => {
    if (!fs.existsSync(candidate.filePath)) return false;
    const document: unknown = parseYaml(fs.readFileSync(candidate.filePath, 'utf8'));
    if (!isRecord(document) || !isRecord(document.groups)) return false;
    return Object.values(document.groups).some(
      (group) =>
        isRecord(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some((row: unknown) => isRecord(row) && isRecord(row.pi) && 'module' in row.pi),
    );
  });
  const parserEntry =
    optionalPackageEntry('@agimon-ai/doompi-hook', pathToFileURL(path.join(options.repoRoot, 'package.json')).href) ??
    optionalPackageEntry('@agimon-ai/doompi-hook', import.meta.url);
  if (hasModuleRows && !parserEntry)
    throw new Error(
      'Hook module rows require @agimon-ai/doompi-hook. Install it in the repository or select a layer that provides it, then run doompi sync.',
    );
  return hasModuleRows && parserEntry
    ? ((await import(pathToFileURL(parserEntry).href)) as HookParserModule)
    : undefined;
}

/** Validate the selected compiled hooks without importing repository code. */
export async function validateHookModules(options: {
  repoRoot: string;
  homeDirectory: string;
  hookGroups?: readonly string[];
  descriptor?: { file: string };
  isSubagent?: boolean;
}): Promise<boolean> {
  const parser = await hookParser(options);
  if (!parser) return false;
  const read = await parser
    .createHookDocumentReader({ homeDirectory: options.homeDirectory, warn: () => undefined })
    .registry(options.repoRoot);
  if (read.failure) throw new Error(read.failure.message);
  const allowed = options.hookGroups === undefined ? undefined : new Set(options.hookGroups);
  const rows = read.entries
    .filter((row) => row.core || !allowed || allowed.has(row.groupId))
    .filter((row) => !(options.isSubagent && row.skipInSubagent));
  const modules = parser.createHookModules({ descriptor: options.descriptor });
  try {
    await modules.validate(rows);
    return rows.some((row) => row.module !== undefined);
  } finally {
    await modules.dispose();
  }
}

/** Bundles hook exports without importing or invoking repository code. */
export async function syncHookModules(options: {
  repoRoot: string;
  homeDirectory: string;
  config: MajorModesConfig;
  directory: string;
  sharedCacheDirectory?: string;
}): Promise<{ file: string }> {
  const parser = await hookParser(options);
  const read = parser
    ? await parser
        .createHookDocumentReader({ homeDirectory: options.homeDirectory, warn: () => undefined })
        .registry(options.repoRoot)
    : { entries: [] };
  if ('failure' in read && read.failure) throw new Error(read.failure.message);
  const groups = requiredHookGroups(options.config);
  const sources = new Map<string, Array<{ registry: string; groupId: string; rowId: string; event: string }>>();
  for (const row of read.entries) {
    if (!row.module || (!row.core && groups && !groups.has(row.groupId))) continue;
    const rows = sources.get(row.module) ?? [];
    rows.push({ registry: row.registryId, groupId: row.groupId, rowId: row.rowId, event: row.event });
    sources.set(row.module, rows);
  }
  const cache = path.join(options.directory, 'cache');
  const outputDirectory = path.join(options.directory, 'dist', 'hooks');
  const modules = [];
  for (const [source, rows] of sources) {
    const compileOptions = {
      repositoryRoot: options.repoRoot,
      outputDirectory,
      outputName: `${crypto.createHash('sha256').update(source).digest('hex')}.mjs`,
      sharedCacheDirectory: options.sharedCacheDirectory,
    };
    try {
      const artifact = await compileExtensionModule(source, cache, compileOptions);
      const receipt = JSON.parse(
        await fs.promises.readFile(extensionModuleManifestPath(source, cache, compileOptions), 'utf8'),
      ) as unknown;
      modules.push({ source, artifact, receipt, rows });
    } catch (cause) {
      const attribution = rows
        .map((row) => `${row.registry}: group ${row.groupId}, row ${row.rowId}, event ${row.event}`)
        .join('; ');
      throw new Error(`Hook module compilation failed (${attribution}): ${source}`, { cause });
    }
  }
  await fs.promises.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(outputDirectory, HOOK_MODULES_FILE);
  await fs.promises.writeFile(file, `${JSON.stringify({ version: 1, modules }, null, 2)}\n`, { mode: 0o600 });
  return { file };
}
