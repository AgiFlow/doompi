import fs from 'node:fs';
import path from 'node:path';

import { GENERATED_DIR } from '../../constants/layout';
import { generateExtension } from '../generate';
import type { GenerateOptions } from '../generate/type';
import { toKebab } from '../identity';
import { writeManifest } from '../syncManifest';

/** The shape a tsdown config needs from this preset, without importing tsdown's types. */
interface BrowserPresetConfig {
  entry: Record<string, string>;
  clean: boolean;
  dts: false;
  exports: boolean;
  format: 'esm'[];
  platform: 'browser';
  fixedExtension: boolean;
  external: (id: string) => boolean;
  sourcemap: boolean;
  unbundle: boolean;
}

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

const DEFAULT_EXPORTS_DIR = 'src/exports';

/** `src/exports/apiContracts.ts` becomes the `api-contracts` entry; index keeps its name. */
function exportEntries(packageDir: string, exportsDir: string): Record<string, string> {
  const absolute = path.join(packageDir, exportsDir);
  if (!fs.existsSync(absolute)) return {};
  const entries: Record<string, string> = {};
  for (const file of fs.readdirSync(absolute)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const stem = file.slice(0, -'.ts'.length);
    entries[stem === 'index' ? 'index' : toKebab(stem)] = `${exportsDir}/${file}`;
  }
  return entries;
}

/**
 * One tsdown config for a folder-routed extension.
 *
 * Entries come from the tree rather than a hand-written list, and the manifest
 * blocks that restate the tree are written after the build rather than kept in
 * step by hand.
 *
 * The cockpit entry is deliberately absent from `entry`: the browser half
 * ships as source and is compiled by the cockpit's bundler, not this one.
 */
export interface ExtensionPresetOptions extends GenerateOptions {
  /** Extra tsdown entries beyond the derived ones. */
  readonly entry?: Record<string, string>;
  /** Public export modules, package-relative. Defaults to `src/exports`. */
  readonly exportsDir?: string;
}

/**
 * The browser half, built as a browser bundle rather than shipped as source.
 *
 * A separate config because platform is per output, and the two halves have
 * nothing in common: this one targets a browser, emits ESM only, and must not
 * clean, because the node build owns dist and runs first.
 *
 * Everything the cockpit supplies page-wide stays external. React is usually a
 * devDependency of a plugin, so tsdown's default externals would bundle it,
 * and a second React in the page does not share hook state with the first.
 */
function browserConfig(): BrowserPresetConfig {
  return {
    entry: { 'extensions/web': `${GENERATED_DIR}/web.ts` },
    clean: false,
    // No declarations. Nothing imports this as a typed module: it has no
    // export subpath, and the cockpit consumes it as a bundle. The browser
    // half is still typechecked, by tsconfig.web.json in the typecheck script.
    dts: false,
    exports: false,
    format: ['esm'],
    platform: 'browser',
    // platform browser turns tsdown's fixedExtension off, which would emit
    // .js. The manifest names .mjs like the other two entries, so ask for it.
    fixedExtension: true,
    // Every bare specifier stays external and the cockpit resolves it, which
    // is what keeps one React and one store in the page no matter how many
    // plugins are installed. An allowlist would have to be kept in step with
    // the cockpit's; this cannot drift.
    //
    // A predicate rather than a pattern: rolldown tests `external` against the
    // resolved id, so /^[^.]/ also matches the absolute path of this package's
    // own routed file and would leave a dangling import to unbuilt .tsx.
    external: (id: string) => !id.startsWith('.') && !path.isAbsolute(id),
    sourcemap: true,
    // Bundled, unlike the node half. Unbundling would emit an import to the
    // routed source file, which is not published and is .tsx besides. One
    // module with only bare specifiers external is what the cockpit wants.
    unbundle: false,
  };
}

export function doompiExtension(
  options: ExtensionPresetOptions = { packageDir: process.cwd() },
): PresetConfig | (PresetConfig | BrowserPresetConfig)[] {
  const packageDir = options.packageDir ?? process.cwd();
  const result = generateExtension({ ...options, packageDir, check: options.check ?? Boolean(process.env.CI) });

  for (const notice of result.notices) process.stderr.write(`[doompi-build] ${notice.path}: ${notice.message}\n`);

  const entry: Record<string, string> = {
    ...exportEntries(packageDir, options.exportsDir ?? DEFAULT_EXPORTS_DIR),
    ...(result.targets.includes('cli') ? { 'extensions/pi': `${GENERATED_DIR}/pi.ts` } : {}),
    ...(result.targets.includes('server') ? { 'extensions/server': `${GENERATED_DIR}/server.ts` } : {}),
    ...options.entry,
  };

  const node: PresetConfig = {
    entry,
    clean: true,
    dts: { incremental: true, parallel: false, eager: true },
    exports: true,
    format: ['esm', 'cjs'],
    // No minify. This is a library build, and a mangled stack trace inside a
    // published extension is far more expensive than the bytes it saves.
    // Not a restriction on what the code may use, and not a claim about the
    // browser half, which tsdown does not build at all. It sets tsdown's
    // fixedExtension, so output lands on .mjs and .d.mts rather than .js and
    // .d.ts. Every consumer here requires that: pi.extensions and
    // doompiServer.dist both name .mjs, and the server bundle schema rejects
    // anything else outright. Both hosts this builds for are Node processes.
    platform: 'node',
    sourcemap: true,
    unbundle: true,
    hooks: {
      'build:done': () =>
        void writeManifest({
          packageDir,
          manifest: JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as Record<
            string,
            unknown
          >,
          graph: result.graph,
          targets: result.targets,
          pluginId: result.pluginId,
        }),
    },
  };

  return result.targets.includes('web') ? [node, browserConfig()] : node;
}
