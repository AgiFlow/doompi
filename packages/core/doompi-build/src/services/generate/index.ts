import fs from 'node:fs';
import path from 'node:path';

import { BUILD_TARGET_PLATFORMS, GENERATED_DIR, GENERATED_ENTRY_NAMES } from '../../constants/layout';
import type { ExtensionGraph, ExtensionNotice } from '../../types/extensionGraph';
import { renderCliEntry, renderServerEntry, renderWebEntry } from '../renderEntry';
import { resolveTarget } from '../resolveTarget';
import type { BuildTarget } from '../resolveTarget/type';
import { scanExtensions } from '../scan';
import { writeGenerated } from '../writeGenerated';
import type { GenerateOptions, GenerateResult } from './type';

/** `@agimon-ai/doompi-plan` becomes `plan`. */
export function defaultPluginId(packageName: string): string {
  return packageName.replace(/^@[^/]+\//u, '').replace(/^doompi-/u, '');
}

function readPackageName(packageDir: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { name?: unknown };
  if (typeof manifest.name !== 'string') throw new Error(`${packageDir}/package.json has no name`);
  return manifest.name;
}

const RENDERERS: Readonly<Record<BuildTarget, typeof renderCliEntry>> = {
  cli: renderCliEntry,
  server: renderServerEntry,
  web: renderWebEntry,
};

/** The generated entry keeps its historical filename so no consumer has to change. */
const ENTRY_FILENAME: Readonly<Record<BuildTarget, string>> = {
  cli: GENERATED_ENTRY_NAMES[0] as string,
  server: GENERATED_ENTRY_NAMES[1] as string,
  web: GENERATED_ENTRY_NAMES[2] as string,
};

const ENTRY_EXTENSION: Readonly<Record<BuildTarget, string>> = { cli: 'ts', server: 'ts', web: 'ts' };

/**
 * Scans a package and renders every entry its tree calls for.
 *
 * A target with nothing in it produces no file, so a backend-only package
 * never grows an empty cockpit entry. Notices from the scan and from each
 * resolution are gathered rather than thrown: an unrecognised folder costs
 * that folder, never the build.
 */
export function generateExtension(options: GenerateOptions): GenerateResult {
  const packageName = options.packageName ?? readPackageName(options.packageDir);
  const pluginId = options.pluginId ?? defaultPluginId(packageName);

  const graph: ExtensionGraph = scanExtensions(options);
  const notices: ExtensionNotice[] = [...graph.notices];
  const files = new Map<string, string>();
  const targets: BuildTarget[] = [];

  // Here rather than in the scan, deliberately. The doomRoutedFilePosition lint
  // rule calls scanExtensions() directly, so a scan notice would make `.ios` a
  // hard preflight failure and cost us the forward-looking platforms we kept on
  // purpose. resolveTarget runs once per target, which would print this 3x.
  for (const entry of graph.entries) {
    if (entry.platform === undefined || BUILD_TARGET_PLATFORMS.includes(entry.platform)) continue;
    notices.push({
      path: entry.file,
      message: `'${entry.platform}' is a forward-looking platform with no build target; this file is not emitted for cli, server or web`,
    });
  }

  for (const target of ['cli', 'server', 'web'] as const) {
    const resolution = resolveTarget(graph, target);
    notices.push(...resolution.notices);
    if (resolution.contributions.length === 0 && resolution.escapeHatches.length === 0 && resolution.roots.length === 0)
      continue;

    targets.push(target);
    const render = RENDERERS[target];
    const source = render(resolution, { packageName, pluginId, root: graph.root, entryDir: GENERATED_DIR });
    files.set(`${GENERATED_DIR}/${ENTRY_FILENAME[target]}.${ENTRY_EXTENSION[target]}`, source);
  }

  const managed = GENERATED_ENTRY_NAMES.map((name) => `${GENERATED_DIR}/${name}.ts`);
  const { changed } = writeGenerated(options.packageDir, files, options.check, managed);
  return { graph, packageName, pluginId, files, changed, notices, targets };
}
