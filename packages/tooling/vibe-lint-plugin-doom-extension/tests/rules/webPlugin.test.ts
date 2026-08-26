import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  webPluginEntry,
  webPluginImportAllowlist,
  webPluginManifest,
  webPluginNoModuleState,
} from '../../src/rules/webPlugin.js';

const CONTRACTS = '@agimon-ai/doompi-web-contracts';
const COMPONENTS = '@agimon-ai/doompi-web-components';

describe('Doom web plugin rules', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-web-plugin-'));
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

  const entry = `import { defineWebPlugin } from '${CONTRACTS}';\nexport const webPlugin = defineWebPlugin({ id: 'demo' });\n`;

  describe('web-plugin-import-allowlist', () => {
    it('accepts the allowed bare and relative imports', () => {
      write('src/types/webDemo.ts', 'export type Demo = { id: string };');
      write('web/demoStore.ts', 'export const x = 1;');
      const filePath = write(
        'web/index.tsx',
        [
          `import { defineWebPlugin } from '${CONTRACTS}';`,
          `import { Button } from '${COMPONENTS}';`,
          "import { useStore } from '@tanstack/react-store';",
          "import { Store } from '@tanstack/store';",
          "import { useState } from 'react';",
          "import type { Demo } from '../src/types/webDemo.ts';",
          "import { x } from './demoStore.ts';",
          'export const webPlugin = defineWebPlugin({ id: "demo" });',
        ].join('\n'),
      );
      expect(webPluginImportAllowlist.check?.(filePath, root)).toBeNull();
    });

    it('rejects node builtins, other packages, and relative imports outside web and src/types', () => {
      const filePath = write(
        'web/index.ts',
        [
          "import fs from 'node:fs';",
          "import { Hono } from 'hono';",
          "import type { Thing } from '@agimon-ai/doompi-ui';",
          "import { helper } from '../src/services/helper.ts';",
          "import { fine } from '../src/types/fine.ts';",
        ].join('\n'),
      );
      const result = webPluginImportAllowlist.check?.(filePath, root);
      expect(result).toContain('node:fs');
      expect(result).toContain('hono');
      expect(result).toContain('@agimon-ai/doompi-ui');
      expect(result).toContain('../src/services/helper.ts');
      expect(result).not.toContain('fine');
    });

    it('ignores files outside web/', () => {
      const filePath = write('src/services/x.ts', "import fs from 'node:fs';");
      expect(webPluginImportAllowlist.check?.(filePath, root)).toBeNull();
    });
  });

  describe('web-plugin-no-module-state', () => {
    it('flags top-level let and var and accepts const stores and function-local let', () => {
      const flagged = write(
        'web/demoStore.ts',
        'let runtime: unknown;\nexport var cache = {};\nexport const store = new Map();\nfunction f() { let local = 1; return local; }\n',
      );
      const result = webPluginNoModuleState.check?.(flagged, root);
      expect(result).toContain('runtime, cache');
      expect(result).toContain('defineSessionStore');

      const fine = write(
        'web/fineStore.ts',
        'export const store = new Map();\nfunction f() { let local = 1; return local; }\n',
      );
      expect(webPluginNoModuleState.check?.(fine, root)).toBeNull();
      expect(webPluginNoModuleState.check?.(write('src/services/x.ts', 'let x = 1;'), root)).toBeNull();
    });
  });

  describe('web-plugin-manifest', () => {
    it('is silent without a doompiWeb block and on other files', () => {
      expect(webPluginManifest.check?.(writeManifest({ name: 'p' }), root)).toBeNull();
      expect(webPluginManifest.check?.(write('web/index.ts', entry), root)).toBeNull();
    });

    it('reports every manifest problem at once', () => {
      write(
        'web/index.ts',
        `import { Button } from '${COMPONENTS}';\nimport type { D } from '../src/types/webDemo.ts';`,
      );
      write('src/types/webDemo.ts', 'export type D = 1;');
      const manifest = writeManifest({
        name: 'p',
        files: ['dist'],
        dependencies: {},
        doompiWeb: {
          pluginId: 'Bad Case',
          registrationOrder: -1,
          client: './web/index.ts',
          hub: { entry: './src/exports/webHub.ts' },
        },
      });
      const result = webPluginManifest.check?.(manifest, root);
      expect(result).toContain("pluginId 'Bad Case' must be kebab-case");
      expect(result).toContain('registrationOrder must be a non-negative integer');
      expect(result).toContain("client './web/index.ts' is not in the files allowlist");
      expect(result).toContain('has no web/tsconfig.json');
      expect(result).toContain("hub.entry './src/exports/webHub.ts' does not exist");
      expect(result).toContain('hub.dist must be');
      expect(result).toContain("web/ imports 'src/types/webDemo.ts', which is not in the files allowlist");
      expect(result).toContain(`${CONTRACTS} must be a dependency`);
      expect(result).toContain(`${COMPONENTS} must be a dependency`);
    });

    it('reports a missing client entry', () => {
      const manifest = writeManifest({
        name: 'p',
        files: ['web'],
        dependencies: { [CONTRACTS]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './web/index.ts' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toContain("client './web/index.ts' does not exist");
    });

    it('accepts a complete manifest, with an array of blocks', () => {
      write('web/index.ts', `import type { D } from '../src/types/webDemo.ts';\n${entry}`);
      write('web/other.ts', entry);
      write('web/tsconfig.json', '{}');
      write('src/types/webDemo.ts', 'export type D = 1;');
      write('src/exports/webHub.ts', 'export const webHubChannels = [];');
      const manifest = writeManifest({
        name: 'p',
        files: ['dist', 'web', 'src/types/webDemo.ts'],
        dependencies: { [CONTRACTS]: 'workspace:*' },
        doompiWeb: [
          {
            pluginId: 'demo',
            client: './web/index.ts',
            hub: { entry: './src/exports/webHub.ts', dist: './dist/webHub.mjs' },
          },
          { pluginId: 'demo-other', registrationOrder: 5, client: './web/other.ts' },
        ],
      });
      expect(webPluginManifest.check?.(manifest, root)).toBeNull();
    });
  });

  describe('web-plugin-entry', () => {
    it('requires the client entry to export webPlugin from defineWebPlugin', () => {
      writeManifest({ name: 'p', doompiWeb: { pluginId: 'demo', client: './web/index.ts' } });
      expect(webPluginEntry.check?.(write('web/index.ts', entry), root)).toBeNull();

      const handRolled = write('web/index.ts', "export const webPlugin = { id: 'demo' };");
      expect(webPluginEntry.check?.(handRolled, root)).toContain('must export webPlugin built with defineWebPlugin');

      const wrongName = write(
        'web/index.ts',
        `import { defineWebPlugin } from '${CONTRACTS}';\nexport const plugin = defineWebPlugin({ id: 'demo' });`,
      );
      expect(webPluginEntry.check?.(wrongName, root)).toContain('must export webPlugin');
    });

    it('ignores other web files and packages without a manifest block', () => {
      writeManifest({ name: 'p', doompiWeb: { pluginId: 'demo', client: './web/index.ts' } });
      expect(webPluginEntry.check?.(write('web/demoStore.ts', 'export const x = 1;'), root)).toBeNull();
      writeManifest({ name: 'p' });
      expect(webPluginEntry.check?.(write('web/index.ts', 'export const x = 1;'), root)).toBeNull();
    });
  });
});
