import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageApiEntry, packageApiManifest } from '../../src/rules/packageApi.js';

describe('Doom package API rules', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-package-api-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relativePath: string, source: string): string {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source, 'utf8');
    return filePath;
  }

  function writeManifest(manifest: Record<string, unknown>): string {
    return write('package.json', JSON.stringify(manifest));
  }

  const session = { entry: './src/exports/sessionApi.ts', dist: './dist/sessionApi.mjs' };
  const apiSource = "export { api } from '../adapters/runnerLogApi.ts';\n";

  /** A package that declares one session API and ships its built entry. */
  function wellFormed(block: Record<string, unknown> = { basePath: 'runner', session }): string {
    write('src/exports/sessionApi.ts', apiSource);
    return writeManifest({ name: 'demo', files: ['dist'], doompiApi: block });
  }

  describe('package-api-manifest', () => {
    it('says nothing about a package that declares no API', () => {
      const manifest = writeManifest({ name: 'demo', files: ['dist'] });
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();
    });

    it('accepts a block whose entry exists and whose built entry is published', () => {
      expect(packageApiManifest.check?.(wellFormed(), root)).toBeNull();
    });

    it('accepts both scopes at once', () => {
      write('src/exports/hubApi.ts', apiSource);
      const manifest = wellFormed({
        basePath: 'runner',
        session,
        hub: { entry: './src/exports/hubApi.ts', dist: './dist/hubApi.mjs' },
      });
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();
    });

    it('rejects a base path that is not kebab-case', () => {
      const manifest = wellFormed({ basePath: 'Not Kebab', session });
      expect(packageApiManifest.check?.(manifest, root)).toMatch(/must be kebab-case/);
    });

    it('rejects a block no host could mount', () => {
      const manifest = wellFormed({ basePath: 'runner' });
      expect(packageApiManifest.check?.(manifest, root)).toMatch(/names neither a session nor a hub entry/);
    });

    it('rejects an entry that does not exist', () => {
      const manifest = writeManifest({
        name: 'demo',
        files: ['dist'],
        doompiApi: { basePath: 'runner', session },
      });
      expect(packageApiManifest.check?.(manifest, root)).toMatch(/session\.entry '.*' does not exist/);
    });

    it('rejects a path that could reach outside the package', () => {
      const manifest = wellFormed({ basePath: 'runner', session: { entry: '../evil.ts', dist: './dist/x.mjs' } });
      expect(packageApiManifest.check?.(manifest, root)).toMatch(/session\.entry must be a package-relative/);
    });

    it('requires a built entry, which is what a host imports', () => {
      const manifest = wellFormed({ basePath: 'runner', session: { entry: session.entry } });
      expect(packageApiManifest.check?.(manifest, root)).toMatch(/session\.dist must be the package-relative/);
    });

    it('rejects a built entry the files allowlist does not publish', () => {
      write('src/exports/sessionApi.ts', apiSource);
      const manifest = writeManifest({ name: 'demo', files: ['src'], doompiApi: { basePath: 'runner', session } });
      expect(packageApiManifest.check?.(manifest, root)).toMatch(/is not in the files allowlist/);
    });

    it('checks every block when a package declares several', () => {
      write('src/exports/sessionApi.ts', apiSource);
      const manifest = writeManifest({
        name: 'demo',
        files: ['dist'],
        doompiApi: [
          { basePath: 'one', session },
          { basePath: 'Two', session },
        ],
      });
      expect(packageApiManifest.check?.(manifest, root)).toMatch(/basePath 'Two' must be kebab-case/);
    });

    it('only looks at a package.json', () => {
      wellFormed();
      expect(packageApiManifest.check?.(path.join(root, 'src/exports/sessionApi.ts'), root)).toBeNull();
    });
  });

  describe('package-api-entry', () => {
    it('accepts an entry that re-exports api', () => {
      const entryPath = write('src/exports/sessionApi.ts', apiSource);
      writeManifest({ name: 'demo', files: ['dist'], doompiApi: { basePath: 'runner', session } });
      expect(packageApiEntry.check?.(entryPath, root)).toBeNull();
    });

    it('accepts an entry that declares api directly', () => {
      const entryPath = write(
        'src/exports/sessionApi.ts',
        "export const api = { basePath: 'runner', start: () => x };\n",
      );
      writeManifest({ name: 'demo', files: ['dist'], doompiApi: { basePath: 'runner', session } });
      expect(packageApiEntry.check?.(entryPath, root)).toBeNull();
    });

    it('rejects an entry that exports something else', () => {
      const entryPath = write('src/exports/sessionApi.ts', "export const webHubApi = { basePath: 'runner' };\n");
      writeManifest({ name: 'demo', files: ['dist'], doompiApi: { basePath: 'runner', session } });
      expect(packageApiEntry.check?.(entryPath, root)).toMatch(/must export api/);
    });

    it('names the scope the entry was declared for', () => {
      const entryPath = write('src/exports/hubApi.ts', 'export const other = 1;\n');
      writeManifest({
        name: 'demo',
        files: ['dist'],
        doompiApi: { basePath: 'runner', hub: { entry: './src/exports/hubApi.ts', dist: './dist/hubApi.mjs' } },
      });
      expect(packageApiEntry.check?.(entryPath, root)).toMatch(/doompiApi hub entry/);
    });

    it('ignores a file the manifest never declared', () => {
      const other = write('src/exports/elsewhere.ts', 'export const other = 1;\n');
      writeManifest({ name: 'demo', files: ['dist'], doompiApi: { basePath: 'runner', session } });
      expect(packageApiEntry.check?.(other, root)).toBeNull();
    });

    it('ignores a package that declares no API', () => {
      const entryPath = write('src/exports/sessionApi.ts', 'export const other = 1;\n');
      writeManifest({ name: 'demo', files: ['dist'] });
      expect(packageApiEntry.check?.(entryPath, root)).toBeNull();
    });
  });
});
