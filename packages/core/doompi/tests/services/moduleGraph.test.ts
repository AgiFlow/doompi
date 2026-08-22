import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CACHE_PACKAGE_ROOT = path.resolve(PACKAGE_ROOT, '../doompi-cache');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(PACKAGE_ROOT, relativePath), 'utf8');
}

function staticImports(contents: string): string[] {
  const imports: string[] = [];
  let current: string[] | undefined;
  for (const line of contents.split('\n')) {
    if (line.startsWith('import ')) current = [line];
    else if (current) current.push(line);
    if (current && line.includes(';')) {
      imports.push(current.join('\n'));
      current = undefined;
    }
  }
  return imports;
}

function runtimeImports(contents: string): string[] {
  return staticImports(contents).filter((statement) => !statement.startsWith('import type '));
}

describe('startup module graph boundaries', () => {
  it('keeps the dedicated Pi entry and package bootstrap dependency-light', () => {
    const entry = source('src/exports/extensions/pi.ts');
    const bootstrap = source('src/adapters/packageBootstrap.ts');

    expect(entry.trim()).toBe("export { packageBootstrap as default } from '../../adapters/packageBootstrap';");
    // bootstrapClaim is on this list deliberately: deduping two installs has to
    // happen before anything else is read, so it may not pull in a graph.
    expect(runtimeImports(bootstrap)).toEqual([
      "import { pathToFileURL } from 'node:url';",
      "import { DOOMPI_EXTENSIONS_PROVIDED_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';",
      "import { acquireBootstrapClaim } from './bootstrapClaim.ts';",
      "import { findSyncedRoot, readStartupBootstrapStatus } from './bootstrapLocator.ts';",
    ]);
    expect(runtimeImports(source('src/adapters/bootstrapClaim.ts'))).toEqual(["import path from 'node:path';"]);
    expect(bootstrap).not.toContain('startupPrecompiler');
    expect(bootstrap).not.toContain('syncedRuntimeBuilder');
  });

  it('loads domain switching through the standalone fixed-core package', () => {
    const composer = source('src/adapters/composer.ts');
    const composition = source('src/services/extensionAssembler.ts');
    const facade = source('src/exports/entries/domains.ts');

    expect(composer).toContain('@agimon-ai/doompi-domain/apply');
    expect(composer).not.toContain("'./matrixSwitcher.ts'");
    expect(composition).toContain('@agimon-ai/doompi-domain/extensions/pi');
    expect(composition).not.toContain('OWN_ENTRIES.domains');
    expect(facade).toContain('@agimon-ai/doompi-domain/extensions/pi');
  });

  it('does not use the config root barrel from startup-selected entries', () => {
    const paths = [
      'src/extensions/entries/doom.ts',
      'src/extensions/entries/styleSystem.ts',
      'src/adapters/config/harnessState.ts',
    ];

    for (const relativePath of paths) {
      expect(source(relativePath), relativePath).not.toMatch(/from ['"]@agimon-ai\/doompi-config['"]/u);
    }
  });

  it('emits dependency-light built interactive entries', () => {
    const domains = source('dist/entries/domains.mjs');
    const bootstrap = source('dist/src/adapters/packageBootstrap.mjs');
    const cacheExtensionPath = path.join(CACHE_PACKAGE_ROOT, 'dist', 'extensions', 'pi.mjs');
    const cacheExtension = fs.readFileSync(cacheExtensionPath, 'utf8');

    expect(domains).toContain('@agimon-ai/doompi-domain/extensions/pi');
    expect(bootstrap).not.toContain('startupPrecompiler');
    expect(staticImports(bootstrap).join('\n')).not.toContain('composer');
    expect(cacheExtension).not.toContain('pi-cache-optimizer/index.ts');
    const cacheImport = cacheExtension.match(/import\(`((?:\.\.\/)+pi-cache-optimizer-[^`]+\.mjs)`\)/u)?.[1];
    expect(cacheImport).toBeDefined();
    expect(fs.existsSync(path.resolve(path.dirname(cacheExtensionPath), cacheImport ?? ''))).toBe(true);
  });
});
