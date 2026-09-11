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
    it('says nothing about a package that declares no legacy API', () => {
      const manifest = writeManifest({ name: 'demo', files: ['dist'] });
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();
    });

    it('rejects the legacy doompiApi declaration', () => {
      const manifest = writeManifest({ name: 'demo', doompiApi: { basePath: 'runner', session: {} } });
      expect(packageApiManifest.check?.(manifest, root)).toMatch(
        /Remove the legacy doompiApi manifest declaration.*DoomServerFacet/,
      );
    });

    it('allows the native doompiServer declaration when its canonical source and export are present', () => {
      write(
        'src/exports/extensions/server.ts',
        'export { serverFacet as default } from "../../adapters/server/facet.ts";',
      );
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
          entry: './src/exports/extensions/server.ts',
          dist: './dist/extensions/server.mjs',
          scopes: ['session', 'hub'],
        },
      });
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();
    });

    it('requires a server declaration for a generated API barrel', () => {
      write('src/exports/sessionApi.ts', 'export { api } from "../adapters/runnerApi.ts";');
      const manifest = writeManifest({ name: 'demo' });

      expect(packageApiManifest.check?.(manifest, root)).toContain(
        'server composition implementation requires package.json doompiServer',
      );

      write(
        'src/exports/extensions/server.ts',
        'export { serverFacet as default } from "../../adapters/server/facet.ts";',
      );
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
          entry: './src/exports/extensions/server.ts',
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

    it('allows a headless-only server composition and a TUI-only package without one', () => {
      write(
        'src/exports/extensions/headless.ts',
        'export { headlessFacet as default } from "../../adapters/headless/facet.ts";',
      );
      const manifest = writeManifest({
        name: 'headless-demo',
        exports: {
          './extensions/headless': {
            types: './dist/extensions/headless.d.mts',
            import: './dist/extensions/headless.mjs',
            require: './dist/extensions/headless.cjs',
          },
        },
        doompiServer: {
          entry: './src/exports/extensions/headless.ts',
          dist: './dist/extensions/headless.mjs',
          scopes: ['session'],
        },
      });
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();

      fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
      const tuiManifest = writeManifest({ name: 'tui-only-demo' });
      write('src/tui/status.ts', 'export const status = true;');
      expect(packageApiManifest.check?.(tuiManifest, root)).toBeNull();
    });

    it('requires a matching published export and rejects noncanonical server paths', () => {
      write(
        'src/exports/extensions/server.ts',
        'export { serverFacet as default } from "../../adapters/server/facet.ts";',
      );
      const missingExport = writeManifest({
        name: 'demo',
        doompiServer: {
          entry: './src/exports/extensions/server.ts',
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
      expect(packageApiManifest.check?.(missingExport, root)).toContain('doompiServer.entry must be');
    });
  });

  it('only looks at a package.json', () => {
    const source = write('src/adapters/runnerApi.ts', 'export const api = {} as unknown;\n');
    writeManifest({ name: 'demo', doompiApi: {} });
    expect(packageApiManifest.check?.(source, root)).toBeNull();
  });
});
