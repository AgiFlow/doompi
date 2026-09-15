import fs from 'node:fs';
import path from 'node:path';

import { generateExtension } from '../generate';
import type { GenerateOptions } from '../generate/type';
import { toKebab } from '../identity';

/** The shape a tsdown config needs from this preset, without importing tsdown's types. */
interface PresetConfig {
  entry: Record<string, string>;
  clean: boolean;
  dts: { incremental: boolean; parallel: boolean; eager: boolean };
  exports: boolean;
  format: ('esm' | 'cjs')[];
  minify: { compress: boolean; mangle: { toplevel: boolean }; codegen: { removeWhitespace: boolean } };
  platform: 'node';
  sourcemap: boolean;
  unbundle: boolean;
}

export interface ExtensionPresetOptions extends GenerateOptions {
  /** Extra tsdown entries beyond the derived ones. */
  readonly entry?: Record<string, string>;
  /** Public export modules, package-relative. Defaults to `src/exports`. */
  readonly exportsDir?: string;
  /** Skip the minify block, as the largest core packages do. */
  readonly minify?: boolean;
}

const DEFAULT_EXPORTS_DIR = 'src/exports';

/** `src/exports/apiContracts.ts` becomes the `api-contracts` entry; index keeps its name. */
function exportEntries(packageDir: string, exportsDir: string): Record<string, string> {
  const absolute = path.join(packageDir, exportsDir);
  if (!fs.existsSync(absolute)) return {};

  const entries: Record<string, string> = {};
  for (const file of fs.readdirSync(absolute).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const stem = file.slice(0, -3);
    entries[stem === 'index' ? 'index' : toKebab(stem)] = `${exportsDir}/${file}`;
  }
  return entries;
}

/**
 * The whole tsdown config for an extension package.
 *
 * Runs the scan and writes the generated entries at config-load time rather
 * than from a plugin hook, because `entry` has to exist before the build graph
 * does. That is the same thing the cockpit's own config already does for its
 * generated plugin registry.
 *
 * The cockpit entry is deliberately absent from `entry`: the browser half
 * ships as source and is compiled by the cockpit's bundler, not this one.
 */
export function doompiExtension(options: ExtensionPresetOptions = { packageDir: process.cwd() }): PresetConfig {
  const packageDir = options.packageDir ?? process.cwd();
  const result = generateExtension({ ...options, packageDir, check: options.check ?? Boolean(process.env.CI) });

  for (const notice of result.notices) process.stderr.write(`[doompi-build] ${notice.path}: ${notice.message}\n`);

  const entry: Record<string, string> = {
    ...exportEntries(packageDir, options.exportsDir ?? DEFAULT_EXPORTS_DIR),
    ...(result.targets.includes('cli') ? { 'extensions/pi': `${result.graph.root}/pi.ts` } : {}),
    ...(result.targets.includes('server') ? { 'extensions/server': `${result.graph.root}/server.ts` } : {}),
    ...options.entry,
  };

  return {
    entry,
    clean: true,
    dts: { incremental: true, parallel: false, eager: true },
    exports: false,
    format: ['esm', 'cjs'],
    minify: { compress: options.minify !== false, mangle: { toplevel: true }, codegen: { removeWhitespace: true } },
    platform: 'node',
    sourcemap: true,
    unbundle: true,
  };
}
