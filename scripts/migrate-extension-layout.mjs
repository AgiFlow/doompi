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

const TSDOWN_CONFIG = `import { doompiExtension } from '@agimon-ai/doompi-build';
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

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Sorted, so a re-run never reorders what a previous one wrote. */
function sortedByKey(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function migrate(packageDir, check) {
  const changed = [];
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = readJson(manifestPath);
  const hasWeb = manifest.doompiWeb !== undefined;

  const write = (relative, contents) => {
    const target = path.join(packageDir, relative);
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === contents) return;
    changed.push(relative);
    if (!check) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
  };

  write('.gitignore', '/generated\n');
  write('tsdown.config.ts', TSDOWN_CONFIG);

  // The build tool is a dev dependency: nothing it writes is imported at runtime.
  manifest.devDependencies = sortedByKey({
    ...manifest.devDependencies,
    '@agimon-ai/doompi-build': 'workspace:*',
  });

  // Host entries move out of src, so the manifest points at the generated ones.
  if (manifest.doompiServer !== undefined) manifest.doompiServer.entry = './generated/server.ts';
  if (hasWeb) manifest.doompiWeb.client = './generated/web.ts';

  // The browser half ships as source and now lives beside what renders it.
  manifest.files = [
    'dist',
    ...(hasWeb ? ['generated/web.ts', 'src/extensions/**/(frontend)/**'] : []),
    ...(manifest.files ?? []).filter(
      (entry) =>
        !['dist', 'src/web', 'src/extensions/web.ts'].includes(entry) &&
        !entry.startsWith('!src/web/') &&
        !entry.startsWith('generated/') &&
        !entry.startsWith('src/extensions/'),
    ),
    ...(hasWeb ? ['!src/extensions/**/*.stories.tsx'] : []),
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
      ...(tsconfig.exclude ?? []).filter((entry) => entry !== 'src/web' && entry !== 'src/extensions/web.ts'),
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
    browser.include = ['src/types', 'src/constants', 'src/extensions/**/(frontend)/**/*', 'generated/web.ts'];
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
