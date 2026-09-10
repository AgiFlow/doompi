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

    it('allows the native doompiServer declaration', () => {
      const manifest = writeManifest({
        name: 'demo',
        doompiServer: {
          entry: './src/exports/extensions/server.ts',
          dist: './dist/extensions/server.mjs',
          scopes: ['session', 'hub'],
        },
      });
      expect(packageApiManifest.check?.(manifest, root)).toBeNull();
    });

    it('only looks at a package.json', () => {
      const source = write('src/adapters/runnerApi.ts', 'export const api = {} as unknown;\n');
      writeManifest({ name: 'demo', doompiApi: {} });
      expect(packageApiManifest.check?.(source, root)).toBeNull();
    });
  });
});
