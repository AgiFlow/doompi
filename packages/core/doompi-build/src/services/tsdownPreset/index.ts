import fs from 'node:fs';
import path from 'node:path';

import { GENERATED_DIR } from '../../constants/layout';
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
  platform: 'node';
  sourcemap: boolean;
  unbundle: boolean;
  hooks: { 'build:done': () => void };
}

export interface ExtensionPresetOptions extends GenerateOptions {
  /** Extra tsdown entries beyond the derived ones. */
  readonly entry?: Record<string, string>;
  /** Public export modules, package-relative. Defaults to `src/exports`. */
  readonly exportsDir?: string;
}

/**
 * Restores the `types` condition tsdown's exports generation omits.
 *
 * tsdown derives the exports map from the built chunks, which is what makes
 * the manifest follow the folder tree instead of being hand-maintained. But
 * its `genSubExport` only ever emits `import`, `require` or `default`: a
 * declaration chunk contributes nothing to a subpath, so only the root gets a
 * top-level `types`. TypeScript still resolves a sibling `.d.mts` under
 * node16 and bundler resolution, but publint and attw both read the condition,
 * and this repository's package contract asserts it.
 *
 * Runs on `build:done`, after tsdown has written the manifest, and only
 * rewrites when something actually changed so a second build is a no-op.
 */
function restoreTypeConditions(packageDir: string): void {
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  const map = manifest.exports;
  if (map === undefined) return;

  let changed = false;
  for (const [subpath, target] of Object.entries(map)) {
    if (subpath === './package.json' || target === null || typeof target !== 'object') continue;
    const conditions = target as Record<string, string>;
    if (conditions.types !== undefined) continue;
    const esm = conditions.import ?? conditions.default;
    if (esm === undefined || !esm.endsWith('.mjs')) continue;
    const types = `${esm.slice(0, -'.mjs'.length)}.d.mts`;
    if (!fs.existsSync(path.join(packageDir, types))) continue;
    // Ahead of import and require: a resolver takes the first condition it
    // matches, and a types-aware one must not fall through to the runtime file.
    map[subpath] = { types, ...conditions };
    changed = true;
  }
  if (changed) fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
    ...(result.targets.includes('cli') ? { 'extensions/pi': `${GENERATED_DIR}/pi.ts` } : {}),
    ...(result.targets.includes('server') ? { 'extensions/server': `${GENERATED_DIR}/server.ts` } : {}),
    ...options.entry,
  };

  return {
    entry,
    clean: true,
    dts: { incremental: true, parallel: false, eager: true },
    exports: true,
    format: ['esm', 'cjs'],
    // No minify. This is a library build, and a mangled stack trace inside a
    // published extension is far more expensive than the bytes it saves.
    platform: 'node',
    sourcemap: true,
    unbundle: true,
    hooks: { 'build:done': () => restoreTypeConditions(packageDir) },
  };
}
