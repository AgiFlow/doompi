import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  webPluginEntry,
  webPluginImportAllowlist,
  webPluginLayerBoundary,
  webPluginManifest,
  webPluginNoModuleState,
  webPluginProtocolLayout,
  webPluginTypedCalls,
} from '../../src/rules/webPlugin.js';

const CORE_PACKAGE = '@agimon-ai/doompi-core';
const CONTRACTS = '@agimon-ai/doompi-core/web';
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

  describe('web-plugin-typed-calls', () => {
    it('rejects raw package frames and accepts scoped typed calls', () => {
      writeManifest({ name: '@agimon-ai/doompi-demo', doompiWeb: { pluginId: 'demo' } });
      const raw = write(
        'src/web/api/raw.ts',
        'export const send = (runtime: any) => runtime.sendHubFrame({ type: "demo" });',
      );
      expect(webPluginTypedCalls.check?.(raw, root)).toContain('runtime.invokeServerMethod');
      const typed = write(
        'src/web/api/typed.ts',
        'export const send = (runtime: any) => runtime.invokeServerMethod({ mount: { scope: "global" }, service: "demo", method: "send", input: {} });',
      );
      expect(webPluginTypedCalls.check?.(typed, root)).toBeNull();
    });

    it('keeps only the explicit Git migration exception', () => {
      writeManifest({ name: '@agimon-ai/doompi-git', doompiWeb: { pluginId: 'git' } });
      const raw = write(
        'src/web/api/raw.ts',
        'export const send = (runtime: any) => runtime.sendHubFrame({ type: "git" });',
      );
      expect(webPluginTypedCalls.check?.(raw, root)).toBeNull();
    });
  });

  describe('web-plugin-protocol-layout', () => {
    it('rejects private transport files and misplaced method definitions', () => {
      writeManifest({ name: '@agimon-ai/doompi-demo', doompiWeb: { pluginId: 'demo' } });
      const socket = write('src/web/api/DemoSocket.ts', 'export const connect = () => undefined;');
      const transport = write('src/adapters/transport/local.ts', 'export const send = () => undefined;');
      const misplaced = write('src/web/api/demoMethod.ts', 'export const method = defineDoomPluginMethod({});');
      expect(webPluginProtocolLayout.check?.(socket, root)).toContain('private protocol or transport');
      expect(webPluginProtocolLayout.check?.(transport, root)).toContain('private protocol or transport');
      expect(webPluginProtocolLayout.check?.(misplaced, root)).toContain('outside src/schemas');
      const schema = write('src/schemas/demoMethod.ts', 'export const method = defineDoomPluginMethod({});');
      expect(webPluginProtocolLayout.check?.(schema, root)).toBeNull();
      const caller = write(
        'src/web/api/demo.ts',
        'export const call = (runtime: any) => runtime.invokeServerMethod({});',
      );
      expect(webPluginProtocolLayout.check?.(caller, root)).toBeNull();
    });
  });

  describe('web-plugin-import-allowlist', () => {
    it('accepts the allowed bare and relative imports', () => {
      write('src/types/webDemo.ts', 'export type Demo = { id: string };');
      write('src/web/demoStore.ts', 'export const x = 1;');
      const filePath = write(
        'src/web/index.tsx',
        [
          `import { defineWebPlugin } from '${CONTRACTS}';`,
          `import { Button } from '${COMPONENTS}';`,
          "import { useStore } from '@tanstack/react-store';",
          "import { Store } from '@tanstack/store';",
          "import { useState } from 'react';",
          "import type { Demo } from '../types/webDemo.ts';",
          "import { x } from './demoStore.ts';",
          'export const webPlugin = defineWebPlugin({ id: "demo" });',
        ].join('\n'),
      );
      expect(webPluginImportAllowlist.check?.(filePath, root)).toBeNull();
    });

    it('rejects node builtins, other packages, and relative imports outside web and src/types', () => {
      const filePath = write(
        'src/web/index.ts',
        [
          "import fs from 'node:fs';",
          "import { Hono } from 'hono';",
          "import type { Thing } from '@agimon-ai/doompi-ui';",
          "import { helper } from '../src/services/helper.ts';",
          "import { fine } from '../types/fine.ts';",
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

  describe('web-plugin-layer-boundary', () => {
    it('accepts the canonical folders and inward imports', () => {
      write('src/web/lib/format.ts', 'export const format = String;');
      write(
        'src/web/stores/itemsStore.ts',
        "import { format } from '../lib/format.ts'; export const item = format(1);",
      );
      const component = write(
        'src/web/components/ItemsPanel.tsx',
        "import { item } from '../stores/itemsStore.ts'; export const ItemsPanel = () => <p>{item}</p>;",
      );
      expect(webPluginLayerBoundary.check?.(component, root)).toBeNull();
      expect(webPluginLayerBoundary.check?.(write('src/web/index.ts', entry), root)).toBeNull();
      expect(webPluginLayerBoundary.check?.(path.join(root, 'src/web/DeletedPanel.tsx'), root)).toBeNull();
    });

    it('rejects flat files, unknown folders, and outward imports', () => {
      const flat = write('src/web/ItemsPanel.tsx', 'export const ItemsPanel = () => null;');
      expect(webPluginLayerBoundary.check?.(flat, root)).toContain('Only src/web/index.ts');

      const unknown = write('src/web/utils/format.ts', 'export const format = String;');
      expect(webPluginLayerBoundary.check?.(unknown, root)).toContain("Unknown web plugin folder 'utils'");

      write('src/web/components/ItemsPanel.tsx', 'export const ItemsPanel = () => null;');
      const store = write(
        'src/web/stores/itemsStore.ts',
        "import { ItemsPanel } from '../components/ItemsPanel.tsx'; export const item = ItemsPanel;",
      );
      expect(webPluginLayerBoundary.check?.(store, root)).toContain('src/web/stores may not import src/web/components');
    });
  });
  describe('web-plugin-no-module-state', () => {
    it('flags top-level let and var and accepts const stores and function-local let', () => {
      const flagged = write(
        'src/web/demoStore.ts',
        'let runtime: unknown;\nexport var cache = {};\nexport const store = new Map();\nfunction f() { let local = 1; return local; }\n',
      );
      const result = webPluginNoModuleState.check?.(flagged, root);
      expect(result).toContain('runtime, cache');
      expect(result).toContain('defineSessionStore');

      const fine = write(
        'src/web/fineStore.ts',
        'export const store = new Map();\nfunction f() { let local = 1; return local; }\n',
      );
      expect(webPluginNoModuleState.check?.(fine, root)).toBeNull();
      expect(webPluginNoModuleState.check?.(write('src/services/x.ts', 'let x = 1;'), root)).toBeNull();
    });
  });

  describe('web-plugin-manifest', () => {
    it('is silent without a doompiWeb block and on other files', () => {
      expect(webPluginManifest.check?.(writeManifest({ name: 'p' }), root)).toBeNull();
      expect(webPluginManifest.check?.(write('src/web/index.ts', entry), root)).toBeNull();
    });

    it('reports every manifest problem at once', () => {
      write(
        'src/web/index.ts',
        `import { Button } from '${COMPONENTS}';\nimport type { D } from '../types/webDemo.ts';`,
      );
      write('src/types/webDemo.ts', 'export type D = 1;');
      const manifest = writeManifest({
        name: 'p',
        files: ['dist'],
        dependencies: {},
        doompiWeb: {
          pluginId: 'Bad Case',
          registrationOrder: -1,
          client: './src/web/index.ts',
          hub: { entry: './src/exports/webHub.ts' },
        },
      });
      const result = webPluginManifest.check?.(manifest, root);
      expect(result).toContain("pluginId 'Bad Case' must be kebab-case");
      expect(result).toContain('registrationOrder must be a non-negative integer');
      expect(result).toContain('client must be ./src/extensions/web.ts');
      expect(result).toContain('has no src/web/tsconfig.json');
      expect(result).toContain('must not declare doompiWeb.hub');
      expect(result).toContain("web/ imports 'src/types/webDemo.ts', which is not in the files allowlist");
      expect(result).toContain(`${CORE_PACKAGE} must be a dependency`);
      expect(result).toContain(`${COMPONENTS} must be a dependency`);
    });

    it('reports a missing client entry', () => {
      const manifest = writeManifest({
        name: 'p',
        files: ['src/web'],
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/web/index.ts' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toContain('client must be ./src/extensions/web.ts');
    });

    it('accepts a complete browser-only manifest with canonical client entries', () => {
      write('src/web/index.ts', `import type { D } from '../types/webDemo.ts';\n${entry}`);
      write('src/web/tsconfig.json', '{}');
      write('src/types/webDemo.ts', 'export type D = 1;');
      write('src/extensions/web.ts', "export { webPlugin } from '../web/index';");
      const manifest = writeManifest({
        name: 'p',
        files: ['dist', 'src/web', 'src/extensions/web.ts', 'src/types/webDemo.ts'],
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: [
          { pluginId: 'demo', client: './src/extensions/web.ts' },
          { pluginId: 'demo-other', registrationOrder: 5, client: './src/extensions/web.ts' },
        ],
      });
      expect(webPluginManifest.check?.(manifest, root)).toBeNull();
    });

    it('requires transitive constants imported through published browser types', () => {
      write('src/extensions/web.ts', "import type { Data } from '../types/data';\n" + entry);
      write('src/types/data.ts', "import { LIMIT } from '../constants/limits'; export type Data = typeof LIMIT;");
      write('src/constants/limits.ts', 'export const LIMIT = 2;');
      const metadata = {
        name: 'p',
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      };
      const files = ['src/extensions/web.ts', 'src/types'];
      let manifest = writeManifest({ ...metadata, files });
      expect(webPluginManifest.check?.(manifest, root)).toContain("browser entry imports 'src/constants/limits.ts'");
      manifest = writeManifest({ ...metadata, files: [...files, 'src/constants/limits.ts'] });
      expect(webPluginManifest.check?.(manifest, root)).toBeNull();
    });

    it('resolves worker query imports and their relative assets while respecting exclusions', () => {
      write('src/extensions/web.ts', "import worker from '../web/worker.ts?worker&url';\n" + entry);
      write('src/web/tsconfig.json', '{}');
      write('src/web/worker.ts', "import data from './assets/model.bin?url'; import '../types/cycle';");
      write('src/web/assets/model.bin', 'model');
      write('src/types/cycle.ts', "export type Cycle = {}; import '../web/worker';");
      const metadata = {
        name: 'p',
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      };
      const files = ['src/extensions/web.ts', 'src/web/**', 'src/types'];
      expect(webPluginManifest.check?.(writeManifest({ ...metadata, files }), root)).toBeNull();
      const missingAsset = writeManifest({ ...metadata, files: [...files, '!src/web/assets/**'] });
      expect(webPluginManifest.check?.(missingAsset, root)).toContain(
        "browser entry imports 'src/web/assets/model.bin'",
      );
    });

    it('accepts a direct browser extension entry', () => {
      write('src/web/tsconfig.json', '{}');
      write('src/extensions/web.ts', entry);
      const manifest = writeManifest({
        name: 'p',
        files: ['dist', 'src/web', 'src/extensions/web.ts'],
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toBeNull();
    });

    it('accepts optional browser peers backed by dev dependencies', () => {
      write('src/web/index.ts', `import { Button } from '${COMPONENTS}';\n${entry}`);
      write('src/web/tsconfig.json', '{}');
      write('src/extensions/web.ts', "export { webPlugin } from '../web/index';");
      const manifest = writeManifest({
        name: 'p',
        files: ['dist', 'src/web', 'src/extensions/web.ts'],
        devDependencies: { [CORE_PACKAGE]: 'workspace:*', [COMPONENTS]: 'workspace:*' },
        peerDependencies: { [CORE_PACKAGE]: 'workspace:*', [COMPONENTS]: 'workspace:*' },
        peerDependenciesMeta: {
          [CORE_PACKAGE]: { optional: true },
          [COMPONENTS]: { optional: true },
        },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      });

      expect(webPluginManifest.check?.(manifest, root)).toBeNull();
    });

    it('rejects browser peers without optional metadata or local dev support', () => {
      write('src/web/index.ts', `import { Button } from '${COMPONENTS}';\n${entry}`);
      write('src/web/tsconfig.json', '{}');
      write('src/extensions/web.ts', "export { webPlugin } from '../web/index';");
      const baseManifest = {
        name: 'p',
        files: ['dist', 'src/web', 'src/extensions/web.ts'],
        peerDependencies: { [CORE_PACKAGE]: 'workspace:*', [COMPONENTS]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      };

      const missingOptional = writeManifest({
        ...baseManifest,
        devDependencies: { [CORE_PACKAGE]: 'workspace:*', [COMPONENTS]: 'workspace:*' },
        peerDependenciesMeta: {},
      });
      expect(webPluginManifest.check?.(missingOptional, root)).toContain(`${CORE_PACKAGE} must be a dependency`);
      expect(webPluginManifest.check?.(missingOptional, root)).toContain(`${COMPONENTS} must be a dependency`);

      const missingDev = writeManifest({
        ...baseManifest,
        devDependencies: {},
        peerDependenciesMeta: {
          [CORE_PACKAGE]: { optional: true },
          [COMPONENTS]: { optional: true },
        },
      });
      expect(webPluginManifest.check?.(missingDev, root)).toContain(`${CORE_PACKAGE} must be a dependency`);
      expect(webPluginManifest.check?.(missingDev, root)).toContain(`${COMPONENTS} must be a dependency`);
    });
  });

  describe('web-plugin-entry', () => {
    it('requires the client entry to export webPlugin from defineWebPlugin', () => {
      writeManifest({ name: 'p', doompiWeb: { pluginId: 'demo', client: './src/web/index.ts' } });
      expect(webPluginEntry.check?.(write('src/web/index.ts', entry), root)).toBeNull();

      const handRolled = write('src/web/index.ts', "export const webPlugin = { id: 'demo' };");
      expect(webPluginEntry.check?.(handRolled, root)).toContain('must export webPlugin built with defineWebPlugin');

      const wrongName = write(
        'src/web/index.ts',
        `import { defineWebPlugin } from '${CONTRACTS}';\nexport const plugin = defineWebPlugin({ id: 'demo' });`,
      );
      expect(webPluginEntry.check?.(wrongName, root)).toContain('must export webPlugin');
    });

    it('ignores other web files and packages without a manifest block', () => {
      writeManifest({ name: 'p', doompiWeb: { pluginId: 'demo', client: './src/web/index.ts' } });
      expect(webPluginEntry.check?.(write('src/web/demoStore.ts', 'export const x = 1;'), root)).toBeNull();
      writeManifest({ name: 'p' });
      expect(webPluginEntry.check?.(write('src/web/index.ts', 'export const x = 1;'), root)).toBeNull();
    });
  });

  // The client entry lives outside the browser component root.
  describe('a client entry published from src/extensions', () => {
    it('accepts a manifest whose client is the direct src/extensions entry', () => {
      write('src/web/index.ts', `import type { D } from '../types/webDemo.ts';\n${entry}`);
      write('src/web/tsconfig.json', '{}');
      write('src/types/webDemo.ts', 'export type D = 1;');
      write('src/extensions/web.ts', "export { webPlugin } from '../web/index';");
      const manifest = writeManifest({
        name: 'p',
        files: ['dist', 'src/web', 'src/extensions/web.ts', 'src/types/webDemo.ts'],
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: {
          pluginId: 'demo',
          client: './src/extensions/web.ts',
        },
      });
      expect(webPluginManifest.check?.(manifest, root)).toBeNull();
    });

    it('reports a missing src/web tsconfig even when the client sits in src/extensions', () => {
      write('src/web/index.ts', entry);
      write('src/extensions/web.ts', "export { webPlugin } from '../web/index';");
      const manifest = writeManifest({
        name: 'p',
        files: ['dist', 'src/web', 'src/extensions/web.ts'],
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toContain('has no src/web/tsconfig.json');
    });

    it('rejects the removed nested browser entry in the manifest', () => {
      const manifest = writeManifest({
        name: 'p',
        doompiWeb: { pluginId: 'demo', client: './src/exports/extensions/web.ts' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toContain('client must be ./src/extensions/web.ts');
    });

    it('follows one re-export hop to validate the client entry', () => {
      writeManifest({ name: 'p', doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' } });
      write('src/web/index.ts', entry);
      const forwarding = write('src/extensions/web.ts', "export { webPlugin } from '../web/index';");
      expect(webPluginEntry.check?.(forwarding, root)).toBeNull();

      write('src/web/index.ts', "export const webPlugin = { id: 'demo' };");
      expect(webPluginEntry.check?.(forwarding, root)).toContain('must export webPlugin');
    });

    it('validates a client entry declared directly in src/web', () => {
      writeManifest({ name: 'p', doompiWeb: { pluginId: 'demo', client: './src/web/index.ts' } });
      expect(webPluginEntry.check?.(write('src/web/index.ts', entry), root)).toBeNull();
      const handRolled = write('src/web/index.ts', "export const webPlugin = { id: 'demo' };");
      expect(webPluginEntry.check?.(handRolled, root)).toContain('must export webPlugin');
    });
  });
});
