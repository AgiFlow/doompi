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
    const bootstrap = source('src/extensions/pi.ts');

    // bootstrapClaim is on this list deliberately: deduping two installs has to
    // happen before anything else is read, so it may not pull in a graph.
    expect(runtimeImports(bootstrap)).toEqual([
      "import { pathToFileURL } from 'node:url';",
      "import { DOOMPI_EXTENSIONS_PROVIDED_ENV } from '@agimon-ai/doompi-core/child-process';",
      "import { acquireBootstrapClaim } from '../builders/cli/bootstrapClaim';",
      "import { findSyncedRoot, readStartupBootstrapStatus } from '../builders/cli/bootstrapLocator';",
    ]);
    expect(runtimeImports(source('src/builders/cli/bootstrapClaim.ts'))).toEqual(["import path from 'node:path';"]);
    expect(bootstrap).not.toContain('startupPrecompiler');
    expect(bootstrap).not.toContain('syncedRuntimeBuilder');
  });

  it('loads domain switching through the standalone fixed-core package', () => {
    const composer = source('src/builders/cli/composition.ts');
    const composition = source('src/builders/cli/extensionAssembler/index.ts');

    expect(composer).toContain('@agimon-ai/doompi-domain/apply');
    expect(composer).not.toContain("'./matrixSwitcher.ts'");
    expect(composition).toContain('@agimon-ai/doompi-domain/extensions/pi');
    expect(composition).not.toContain('OWN_ENTRIES.domains');
  });

  it('does not use the config root barrel from startup-selected entries', () => {
    const paths = [
      'src/extensions/composedPi.ts',
      'src/extensions/styleSystem.ts',
      'src/composition/harnessState/index.ts',
    ];

    for (const relativePath of paths) {
      expect(source(relativePath), relativePath).not.toMatch(/from ['"]@agimon-ai\/doompi-config['"]/u);
    }
  });

  it('emits dependency-light built interactive entries', () => {
    const bootstrap = source('dist/extensions/pi.mjs');
    const cacheExtensionPath = path.join(CACHE_PACKAGE_ROOT, 'dist', 'extensions', 'pi.mjs');
    const cacheExtension = fs.readFileSync(cacheExtensionPath, 'utf8');

    expect(bootstrap).not.toContain('startupPrecompiler');
    expect(staticImports(bootstrap).join('\n')).not.toContain('composer');
    expect(cacheExtension).not.toContain('pi-cache-optimizer/index.ts');
    const cacheImport = cacheExtension.match(/import\(`((?:\.\.\/)+pi-cache-optimizer-[^`]+\.mjs)`\)/u)?.[1];
    expect(cacheImport).toBeDefined();
    expect(fs.existsSync(path.resolve(path.dirname(cacheExtensionPath), cacheImport ?? ''))).toBe(true);
  });
});
