#!/usr/bin/env node
/**
 * Moves one package's build onto the folder convention.
 *
 * Only the mechanical half: the build config, the manifest fields and the two
 * tsconfigs. Deciding which surface each contribution belongs to is judgement
 * this cannot make, so the routed files under src/extensions stay hand-written
 * and the old entries are left in place until they are.
 *
 * Usage: node scripts/migrate-extension-layout.mjs <packageDir> [--check]
 */
import fs from 'node:fs';
import path from 'node:path';

const TSDOWN_CONFIG = `import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

/**
 * The whole build. Entries come from the folder tree under src/extensions,
 * and the host entries this package publishes are written to generated/.
 */
export default defineConfig(doompiExtension());
`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}


/** Sorted, so a re-run never reorders what a previous one wrote. */
function sortedByKey(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function hasRoutedSide(packageDir, side) {
  const root = path.join(packageDir, 'src/extensions');
  if (!fs.existsSync(root)) return false;

  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === `(${side})`) return true;
      pending.push(path.join(directory, entry.name));
    }
  }
  return false;
}

function appendIgnoredDirectory(file, directory, check, changed) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = current.split(/\r?\n/u);
  if (lines.includes(directory)) return;
  changed.push(path.basename(file));
  if (!check) fs.writeFileSync(file, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${directory}\n`);
}

function migrate(packageDir, check) {
  const changed = [];
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = readJson(manifestPath);
  const hasWeb = manifest.doompiWeb !== undefined;
  const needsBackend = manifest.pi !== undefined || manifest.doompiServer !== undefined;
  if (needsBackend && !hasRoutedSide(packageDir, 'backend')) {
    throw new Error(`${packageDir}: refusing migration before routed (backend) contributions exist`);
  }
  if (hasWeb && !hasRoutedSide(packageDir, 'frontend')) {
    throw new Error(`${packageDir}: refusing migration before routed (frontend) contributions exist`);
  }

  const write = (relative, contents) => {
    const target = path.join(packageDir, relative);
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === contents) return;
    changed.push(relative);
    if (!check) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
  };

  const tsdownPath = path.join(packageDir, 'tsdown.config.ts');
  const existingTsdown = fs.existsSync(tsdownPath) ? fs.readFileSync(tsdownPath, 'utf8') : null;
  if (existingTsdown !== null && existingTsdown !== TSDOWN_CONFIG && !existingTsdown.includes('doompiExtension(')) {
    throw new Error(`${packageDir}: refusing to overwrite custom tsdown.config.ts; migrate its entries manually`);
  }
  appendIgnoredDirectory(path.join(packageDir, '.gitignore'), '/generated', check, changed);
  if (existingTsdown === null) write('tsdown.config.ts', TSDOWN_CONFIG);

  // The build tool is a dev dependency: nothing it writes is imported at runtime.
  manifest.devDependencies = sortedByKey({
    ...manifest.devDependencies,
    '@agimon-ai/doompi-build': 'workspace:*',
  });

  // The build derives doompiServer, doompiWeb and pi from the tree, so they
  // are left alone here: the first build after this rewrites them.
  //
  // Add built output without deleting package-owned source resources. The
  // generator can replace host metadata, but it cannot know whether a prompt,
  // model, worker, or other src/** file is part of the published contract.
  manifest.files = [
    'dist',
    ...(manifest.files ?? []).filter((entry) => entry !== 'dist' && !entry.startsWith('generated/')),
  ];

  if (manifest.scripts?.typecheck !== undefined && hasWeb) {
    manifest.scripts.typecheck = 'tsc --noEmit && tsc --noEmit -p tsconfig.web.json';
  }

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (fs.readFileSync(manifestPath, 'utf8') !== manifestText) {
    changed.push('package.json');
    if (!check) fs.writeFileSync(manifestPath, manifestText);
  }

  const tsconfigPath = path.join(packageDir, 'tsconfig.json');
  const tsconfig = readJson(tsconfigPath);
  tsconfig.include = [...new Set([...(tsconfig.include ?? ['src', 'tests']), 'generated'])];
  tsconfig.exclude = [
    ...new Set([
      // src/web stays excluded: a package with browser code shared across
      // several routed files keeps it there rather than colocating it twice.
      ...(tsconfig.exclude ?? []).filter((entry) => entry !== 'src/extensions/web.ts'),
      ...(hasWeb ? ['src/web'] : []),
      ...(hasWeb ? ['src/extensions/**/(frontend)/**/*', 'generated/web.ts'] : []),
    ]),
  ];
  const tsconfigText = `${JSON.stringify(tsconfig, null, 2)}\n`;
  if (fs.readFileSync(tsconfigPath, 'utf8') !== tsconfigText) {
    changed.push('tsconfig.json');
    if (!check) fs.writeFileSync(tsconfigPath, tsconfigText);
  }

  if (hasWeb) {
    const legacy = path.join(packageDir, 'src/web/tsconfig.json');
    const browser = fs.existsSync(legacy)
      ? readJson(legacy)
      : { compilerOptions: { jsx: 'react-jsx', lib: ['ES2023', 'DOM', 'DOM.Iterable'], noEmit: true, strict: true } };
    browser.include = [
      'src/web',
      'src/types',
      'src/constants',
      'src/extensions/**/(frontend)/**/*',
      'generated/web.ts',
    ];
    write('tsconfig.web.json', `${JSON.stringify(browser, null, 2)}\n`);
  }

  return changed;
}

const [packageDir, ...flags] = process.argv.slice(2);
if (packageDir === undefined) {
  process.stderr.write('usage: migrate-extension-layout.mjs <packageDir> [--check]\n');
  process.exit(2);
}
const check = flags.includes('--check');
const changed = migrate(path.resolve(packageDir), check);
process.stdout.write(
  changed.length === 0
    ? `${packageDir}: already migrated\n`
    : `${packageDir}: ${check ? 'would change' : 'changed'} ${changed.join(', ')}\n`,
);
