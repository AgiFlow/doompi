import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageApiManifest } from '../../src/rules/packageApi.js';

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

  describe('package-api-manifest', () => {
    it('says nothing about a package that declares no extension surface', () => {
      const manifest = writeManifest({ name: 'demo', files: ['dist'] });
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();
    });

    it('rejects a hand-authored browser export map', () => {
      const manifest = writeManifest({
        name: 'demo',
        exports: {
          './extensions/web': {
            types: './dist/extensions/web.d.mts',
            import: './dist/extensions/web.mjs',
          },
        },
      });
      expect(packageApiManifest.check?.(manifest, root)).toContain(
        'Do not edit package.json exports ./extensions/web; tsdown must generate its import-only',
      );
    });

    it("accepts tsdown's import-only browser export", () => {
      const manifest = writeManifest({
        name: 'demo',
        exports: { './extensions/web': { import: './dist/extensions/web.mjs' } },
      });
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();
    });

    it('allows the native doompiServer declaration when its canonical source and export are present', () => {
      write('src/extensions/server.ts', 'export default defineServerPlugin({ name: "demo", session: {} });');
      const manifest = writeManifest({
        name: 'demo',
        exports: {
          './extensions/server': {
            types: './dist/extensions/server.d.mts',
            import: './dist/extensions/server.mjs',
            require: './dist/extensions/server.cjs',
          },
        },
        doompiServer: {
          entry: './src/extensions/server.ts',
          dist: './dist/extensions/server.mjs',
          scopes: ['global', 'workspace', 'session'],
        },
      });
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();
    });

    it('accepts a direct server extension entry', () => {
      write('src/extensions/server.ts', 'export const serverFacet = {}; export default serverFacet;');
      const manifest = writeManifest({
        name: 'demo',
        exports: {
          './extensions/server': {
            types: './dist/extensions/server.d.mts',
            import: './dist/extensions/server.mjs',
            require: './dist/extensions/server.cjs',
          },
        },
        doompiServer: {
          entry: './src/extensions/server.ts',
          dist: './dist/extensions/server.mjs',
          scopes: ['session'],
        },
      });
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();
    });

    it('requires a server declaration for a server implementation', () => {
      write('src/adapters/server/runnerApi.ts', 'export const api = {};');
      const manifest = writeManifest({ name: 'demo' });

      expect(packageApiManifest.check?.(manifest, root)).toContain(
        'server composition implementation requires package.json doompiServer',
      );

      write('src/extensions/server.ts', 'export default defineServerPlugin({ name: "demo", session: {} });');
      const completeManifest = writeManifest({
        name: 'demo',
        exports: {
          './extensions/server': {
            types: './dist/extensions/server.d.mts',
            import: './dist/extensions/server.mjs',
            require: './dist/extensions/server.cjs',
          },
        },
        doompiServer: {
          entry: './src/extensions/server.ts',
          dist: './dist/extensions/server.mjs',
          scopes: ['session'],
        },
      });
      expect(packageApiManifest.check?.(completeManifest, root)).toBeNull();
    });

    it('requires a server declaration when a server implementation is present', () => {
      write('src/adapters/server/facet.ts', 'export const serverFacet = {};');
      const manifest = writeManifest({ name: 'demo' });

      expect(packageApiManifest.check?.(manifest, root)).toContain(
        'server composition implementation requires package.json doompiServer',
      );
    });

    it('rejects an executable public surface entry', () => {
      write('src/extensions/pi.ts', 'export default function extension(): void {}');
      write('src/exports/webClient.ts', 'export const webPlugin = {};');
      const manifest = writeManifest({
        name: 'demo',
        exports: { './extensions/pi': './dist/extensions/pi.mjs' },
        pi: { extensions: ['./dist/extensions/pi.mjs'] },
        doompiWeb: {
          pluginId: 'demo',
          client: './src/exports/webClient.ts',
        },
      });

      expect(packageApiManifest.check?.(manifest, root)).toContain(
        'Canonical surface entry ./src/exports/webClient.ts',
      );
    });

    it('requires a default server export and accepts an explicit alias of the named plugin', () => {
      const source = write(
        'src/extensions/server.ts',
        'export const serverPlugin = defineServerPlugin({ name: "demo" });',
      );
      const manifest = writeManifest({
        name: 'demo',
        doompiServer: {
          entry: './src/extensions/server.ts',
          dist: './dist/extensions/server.mjs',
          scopes: ['session'],
        },
        exports: {
          './extensions/server': {
            types: './dist/extensions/server.d.mts',
            import: './dist/extensions/server.mjs',
            require: './dist/extensions/server.cjs',
          },
        },
      });
      expect(packageApiManifest.check?.(manifest, root)).toContain(
        'must export its defineServerPlugin value as default',
      );
      fs.appendFileSync(source, '\nexport { serverPlugin as default };');
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();
    });

    it('rejects the removed nested server source even when that file exists', () => {
      write('src/exports/extensions/server.ts', 'export default {};');
      const manifest = writeManifest({
        name: 'demo',
        doompiServer: {
          entry: './src/exports/extensions/server.ts',
          dist: './dist/extensions/server.mjs',
          scopes: ['session'],
        },
        exports: { './extensions/server': './dist/extensions/server.mjs' },
      });
      expect(packageApiManifest.check?.(manifest, root)).toContain(
        'doompiServer.entry must be one of ./src/extensions/server.ts or ./generated/server.ts',
      );
    });

    it('requires a matching published export and rejects noncanonical server paths', () => {
      write('src/extensions/server.ts', 'export default defineServerPlugin({ name: "demo", session: {} });');
      const missingExport = writeManifest({
        name: 'demo',
        doompiServer: {
          entry: './src/extensions/server.ts',
          dist: './dist/extensions/server.mjs',
          scopes: ['session'],
        },
      });
      expect(packageApiManifest.check?.(missingExport, root)).toContain(
        'package.json exports must publish ./extensions/server',
      );

      fs.writeFileSync(
        missingExport,
        JSON.stringify({
          name: 'demo',
          doompiServer: {
            entry: './src/extensions/server.ts',
            dist: './dist/extensions/server.mjs',
            scopes: ['session'],
          },
        }),
      );
      expect(packageApiManifest.check?.(missingExport, root)).toContain('package.json exports must publish');
    });
  });

  it('only looks at a package.json', () => {
    const source = write('src/controllers/runnerApi.ts', 'export const api = {} as unknown;\n');
    writeManifest({ name: 'demo', doompiApi: {} });
    expect(packageApiManifest.check?.(source, root)).toBeNull();
  });
});
