import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { doomConfigCandidates } from '@agimon-ai/doompi-config/layeredConfig';
import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { optionalPackageEntry } from '@agimon-ai/doompi-core/moduleResolution';

import { compileExtensionModule, extensionModuleManifestPath } from '../../compiler';

export const HOOK_MODULES_FILE = 'hook-modules.json';

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

/** Bundles hook exports without importing or invoking repository code. */
export async function syncHookModules(options: {
  repoRoot: string;
  homeDirectory: string;
  config: MajorModesConfig;
  directory: string;
  sharedCacheDirectory?: string;
}): Promise<{ file: string }> {
  const candidates = doomConfigCandidates('hooks.yaml', options.repoRoot, options.homeDirectory);
  const registryPresent = candidates.some((candidate) => fs.existsSync(candidate.filePath));
  const parserEntry =
    optionalPackageEntry('@agimon-ai/doompi-hook', pathToFileURL(path.join(options.repoRoot, 'package.json')).href) ??
    optionalPackageEntry('@agimon-ai/doompi-hook', import.meta.url);
  if (registryPresent && !parserEntry)
    throw new Error('Hook registry requires the installed @agimon-ai/doompi-hook package');
  const parser = parserEntry
    ? ((await import(pathToFileURL(parserEntry).href)) as typeof import('@agimon-ai/doompi-hook'))
    : undefined;
  const read =
    registryPresent && parser
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
