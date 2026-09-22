import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  webPluginEntry,
  webPluginImportAllowlist,
  webPluginManifest,
  webPluginNoModuleState,
  webPluginProtocolLayout,
  webPluginTypedCalls,
} from '../../src/rules/webPlugin.js';

const CORE_PACKAGE = '@agimon-ai/doompi-core';
const CONTRACTS = '@agimon-ai/doompi-core/web';
const COMPONENTS = '@agimon-ai/doompi-web-components';
/** The routed browser half: a (frontend) side group under a scope. */
const FRONTEND = 'src/extensions/sessions/(frontend)';
/** From a file directly under a FRONTEND surface back to src/. */
const TO_SRC = '../../../..';
/** From a file in a surface's private folder back to src/. */
const TO_SRC_FROM_PRIVATE = '../../../../..';

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
        `${FRONTEND}/api/_lib/raw.ts`,
        'export const send = (runtime: any) => runtime.sendHubFrame({ type: "demo" });',
      );
      expect(webPluginTypedCalls.check?.(raw, root)).toContain('runtime.invokeServerMethod');
      const typed = write(
        `${FRONTEND}/api/_lib/typed.ts`,
        'export const send = (runtime: any) => runtime.invokeServerMethod({ mount: { scope: "global" }, service: "demo", method: "send", input: {} });',
      );
      expect(webPluginTypedCalls.check?.(typed, root)).toBeNull();
    });

    it('leaves the terminal half of the same side alone', () => {
      writeManifest({ name: '@agimon-ai/doompi-demo', doompiWeb: { pluginId: 'demo' } });
      const overlay = write(
        `${FRONTEND}/overlay/_lib/raw.ts`,
        'export const send = (runtime: any) => runtime.sendHubFrame({ type: "demo" });',
      );
      expect(webPluginTypedCalls.check?.(overlay, root)).toBeNull();
    });

    it('keeps only the explicit Git migration exception', () => {
      writeManifest({ name: '@agimon-ai/doompi-git', doompiWeb: { pluginId: 'git' } });
      const raw = write(
        `${FRONTEND}/api/_lib/raw.ts`,
        'export const send = (runtime: any) => runtime.sendHubFrame({ type: "git" });',
      );
      expect(webPluginTypedCalls.check?.(raw, root)).toBeNull();
    });
  });

  describe('web-plugin-protocol-layout', () => {
    it('rejects private transport files and misplaced method definitions', () => {
      writeManifest({ name: '@agimon-ai/doompi-demo', doompiWeb: { pluginId: 'demo' } });
      const socket = write(`${FRONTEND}/api/_lib/DemoSocket.ts`, 'export const connect = () => undefined;');
      const transport = write('src/adapters/transport/local.ts', 'export const send = () => undefined;');
      const misplaced = write(
        `${FRONTEND}/api/_lib/demoMethod.ts`,
        'export const method = defineDoomPluginMethod({});',
      );
      expect(webPluginProtocolLayout.check?.(socket, root)).toContain('private protocol or transport');
      expect(webPluginProtocolLayout.check?.(transport, root)).toContain('private protocol or transport');
      expect(webPluginProtocolLayout.check?.(misplaced, root)).toContain('outside src/schemas');
      const schema = write('src/schemas/demoMethod.ts', 'export const method = defineDoomPluginMethod({});');
      expect(webPluginProtocolLayout.check?.(schema, root)).toBeNull();
      const caller = write(
        `${FRONTEND}/api/_lib/demo.ts`,
        'export const call = (runtime: any) => runtime.invokeServerMethod({});',
      );
      expect(webPluginProtocolLayout.check?.(caller, root)).toBeNull();
    });

    it('allows a typed public facade for the generated browser plugin', () => {
      writeManifest({ name: '@agimon-ai/doompi-demo', doompiWeb: { pluginId: 'demo' } });
      const facade = write('src/exports/webClient.ts', "export { webPlugin } from '../../generated/web';");
      expect(webPluginProtocolLayout.check?.(facade, root)).toBeNull();
    });
    it('reads the socket name through the platform suffix', () => {
      writeManifest({ name: '@agimon-ai/doompi-demo', doompiWeb: { pluginId: 'demo' } });
      const suffixed = write(`${FRONTEND}/channel/demoSocket.web.ts`, 'export default { connect: () => undefined };');
      expect(webPluginProtocolLayout.check?.(suffixed, root)).toContain('private protocol or transport');
    });
  });

  describe('web-plugin-import-allowlist', () => {
    it('accepts the allowed bare and relative imports', () => {
      write('src/types/webDemo.ts', 'export type Demo = { id: string };');
      write(`${FRONTEND}/tab/_lib/demoStore.ts`, 'export const x = 1;');
      const filePath = write(
        `${FRONTEND}/tab/demo.web.tsx`,
        [
          `import { defineWebPlugin } from '${CONTRACTS}';`,
          `import { Button } from '${COMPONENTS}';`,
          "import { useStore } from '@tanstack/react-store';",
          "import { Store } from '@tanstack/store';",
          "import { useState } from 'react';",
          `import type { Demo } from '${TO_SRC}/types/webDemo.ts';`,
          "import { x } from './_lib/demoStore.ts';",
          'export const webPlugin = defineWebPlugin({ id: "demo" });',
        ].join('\n'),
      );
      expect(webPluginImportAllowlist.check?.(filePath, root)).toBeNull();
    });

    it('allows the browser MCP App SDK but not its server or host subpaths', () => {
      const app = write(`${FRONTEND}/_lib/sessionApp.ts`, "import { App } from '@modelcontextprotocol/ext-apps';");
      expect(webPluginImportAllowlist.check?.(app, root)).toBeNull();
      for (const specifier of [
        '@modelcontextprotocol/ext-apps/server',
        '@modelcontextprotocol/ext-apps/app-bridge',
        '@modelcontextprotocol/sdk/server/index.js',
      ]) {
        const file = write(`${FRONTEND}/_lib/invalid.ts`, `import { Server } from '${specifier}';`);
        expect(webPluginImportAllowlist.check?.(file, root)).toContain(specifier);
      }
    });

    it('rejects node builtins, other packages, and relative imports outside the browser half and src/types', () => {
      const filePath = write(
        `${FRONTEND}/tab/demo.web.ts`,
        [
          "import fs from 'node:fs';",
          "import { Hono } from 'hono';",
          "import type { Thing } from '@agimon-ai/doompi-ui';",
          `import { helper } from '${TO_SRC}/services/helper.ts';`,
          `import { fine } from '${TO_SRC}/types/fine.ts';`,
        ].join('\n'),
      );
      const result = webPluginImportAllowlist.check?.(filePath, root);
      expect(result).toContain('node:fs');
      expect(result).toContain('hono');
      expect(result).toContain('@agimon-ai/doompi-ui');
      expect(result).toContain(`${TO_SRC}/services/helper.ts`);
      expect(result).not.toContain('fine');
    });

    // Delete with the folder: a routed browser file may still reach the src/web
    // modules it has not absorbed yet.
    it('still allows a routed browser file to reach src/web', () => {
      write('src/web/components/DemoPanel.tsx', 'export const DemoPanel = () => null;');
      const filePath = write(
        `${FRONTEND}/fill/Demo.activity.demo.web.tsx`,
        `import { DemoPanel } from '${TO_SRC}/web/components/DemoPanel';`,
      );
      expect(webPluginImportAllowlist.check?.(filePath, root)).toBeNull();
    });

    it('ignores files outside the browser half', () => {
      expect(
        webPluginImportAllowlist.check?.(write('src/services/x.ts', "import fs from 'node:fs';"), root),
      ).toBeNull();
      const terminal = write(`${FRONTEND}/overlay/demo.cli.tsx`, "import fs from 'node:fs';");
      expect(webPluginImportAllowlist.check?.(terminal, root)).toBeNull();
    });
  });

  describe('web-plugin-no-module-state', () => {
    it('flags top-level let and var and accepts const stores and function-local let', () => {
      const flagged = write(
        `${FRONTEND}/tab/_lib/demoStore.ts`,
        'let runtime: unknown;\nexport var cache = {};\nexport const store = new Map();\nfunction f() { let local = 1; return local; }\n',
      );
      const result = webPluginNoModuleState.check?.(flagged, root);
      expect(result).toContain('runtime, cache');
      expect(result).toContain('defineSessionStore');

      const fine = write(
        `${FRONTEND}/tab/_lib/fineStore.ts`,
        'export const store = new Map();\nfunction f() { let local = 1; return local; }\n',
      );
      expect(webPluginNoModuleState.check?.(fine, root)).toBeNull();
      expect(webPluginNoModuleState.check?.(write('src/services/x.ts', 'let x = 1;'), root)).toBeNull();
    });
  });

  describe('web-plugin-manifest', () => {
    it('is silent without a doompiWeb block and on other files', () => {
      expect(webPluginManifest.check?.(writeManifest({ name: 'p' }), root)).toBeNull();
      expect(webPluginManifest.check?.(write(`${FRONTEND}/tab/demo.web.ts`, entry), root)).toBeNull();
    });

    it('reports every manifest problem at once', () => {
      write(
        `${FRONTEND}/tab/demo.web.tsx`,
        `import { Button } from '${COMPONENTS}';\nimport type { D } from '${TO_SRC}/types/webDemo.ts';`,
      );
      write('src/types/webDemo.ts', 'export type D = 1;');
      const manifest = writeManifest({
        name: 'p',
        files: ['dist'],
        dependencies: {},
        doompiWeb: {
          pluginId: 'Bad Case',
          registrationOrder: -1,
          client: './src/exports/webClient.ts',
          hub: { entry: './src/exports/webHub.ts' },
        },
      });
      const result = webPluginManifest.check?.(manifest, root);
      expect(result).toContain("pluginId 'Bad Case' must be kebab-case");
      expect(result).toContain('registrationOrder must be a non-negative integer');
      expect(result).toContain('client must be one of ./src/extensions/web.ts or ./dist/extensions/web.mjs');
      expect(result).toContain('must not declare doompiWeb.hub');
      expect(result).toContain("the browser half imports 'src/types/webDemo.ts', which is not in the files allowlist");
      expect(result).toContain(`${CORE_PACKAGE} must be a dependency`);
      expect(result).toContain(`${COMPONENTS} must be a dependency`);
    });

    it('reports a missing client entry', () => {
      const manifest = writeManifest({
        name: 'p',
        files: ['src/extensions/web.ts'],
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toContain("client './src/extensions/web.ts' does not exist");
    });

    it('accepts a complete browser-only manifest with canonical client entries', () => {
      write('src/types/webDemo.ts', 'export type D = 1;');
      write('src/extensions/web.ts', `import type { D } from '../types/webDemo.ts';\n${entry}`);
      const manifest = writeManifest({
        name: 'p',
        files: ['dist', 'src/extensions/web.ts', 'src/types/webDemo.ts'],
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
      write(
        'src/extensions/web.ts',
        `import worker from './sessions/(frontend)/tab/_lib/worker.ts?worker&url';\n${entry}`,
      );
      write(
        `${FRONTEND}/tab/_lib/worker.ts`,
        `import data from './assets/model.bin?url'; import '${TO_SRC_FROM_PRIVATE}/types/cycle';`,
      );
      write(`${FRONTEND}/tab/_lib/assets/model.bin`, 'model');
      write(
        'src/types/cycle.ts',
        `export type Cycle = {}; import '../extensions/sessions/(frontend)/tab/_lib/worker';`,
      );
      const metadata = {
        name: 'p',
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      };
      const files = ['src/extensions/**', 'src/types'];
      expect(webPluginManifest.check?.(writeManifest({ ...metadata, files }), root)).toBeNull();
      const missingAsset = writeManifest({ ...metadata, files: [...files, `!${FRONTEND}/**/assets/**`] });
      expect(webPluginManifest.check?.(missingAsset, root)).toContain(
        `browser entry imports '${FRONTEND}/tab/_lib/assets/model.bin'`,
      );
    });

    it('accepts a direct browser extension entry', () => {
      write('src/extensions/web.ts', entry);
      const manifest = writeManifest({
        name: 'p',
        files: ['dist', 'src/extensions/web.ts'],
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toBeNull();
    });

    it('accepts a routed browser bundle before build output exists', () => {
      write(
        `${FRONTEND}/tab/demo.web.ts`,
        `import type { Demo } from '${TO_SRC}/types/demo'; export type View = Demo;`,
      );
      write('src/types/demo.ts', 'export type Demo = string;');
      write('tsconfig.web.json', '{}');
      const manifest = writeManifest({
        name: 'p',
        files: ['dist'],
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './dist/extensions/web.mjs' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toBeNull();
    });

    it('requires the routed browser tsconfig at the package root', () => {
      write(`${FRONTEND}/tab/demo.web.ts`, entry);
      const manifest = writeManifest({
        name: 'p',
        files: ['dist'],
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './dist/extensions/web.mjs' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toContain('has no tsconfig.web.json');
    });

    it('accepts optional browser peers backed by dev dependencies', () => {
      write(`${FRONTEND}/tab/demo.web.tsx`, `import { Button } from '${COMPONENTS}';\n${entry}`);
      write('src/extensions/web.ts', "export { webPlugin } from './sessions/(frontend)/tab/demo.web';");
      const manifest = writeManifest({
        name: 'p',
        files: ['dist', 'src/extensions'],
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
      write(`${FRONTEND}/tab/demo.web.tsx`, `import { Button } from '${COMPONENTS}';\n${entry}`);
      write('src/extensions/web.ts', "export { webPlugin } from './sessions/(frontend)/tab/demo.web';");
      const baseManifest = {
        name: 'p',
        files: ['dist', 'src/extensions'],
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
      writeManifest({ name: 'p', doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' } });
      expect(webPluginEntry.check?.(write('src/extensions/web.ts', entry), root)).toBeNull();

      const handRolled = write('src/extensions/web.ts', "export const webPlugin = { id: 'demo' };");
      expect(webPluginEntry.check?.(handRolled, root)).toContain('must export webPlugin built with defineWebPlugin');

      const wrongName = write(
        'src/extensions/web.ts',
        `import { defineWebPlugin } from '${CONTRACTS}';\nexport const plugin = defineWebPlugin({ id: 'demo' });`,
      );
      expect(webPluginEntry.check?.(wrongName, root)).toContain('must export webPlugin');
    });

    it('ignores other browser files and packages without a manifest block', () => {
      writeManifest({ name: 'p', doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' } });
      const helper = write(`${FRONTEND}/tab/_lib/demoStore.ts`, 'export const x = 1;');
      expect(webPluginEntry.check?.(helper, root)).toBeNull();
      writeManifest({ name: 'p' });
      expect(webPluginEntry.check?.(write('src/extensions/web.ts', 'export const x = 1;'), root)).toBeNull();
    });
  });

  // The client entry lives outside the browser surfaces it composes.
  describe('a client entry published from src/extensions', () => {
    it('checks the routed browser half against the files allowlist', () => {
      write(
        `${FRONTEND}/tab/demo.web.tsx`,
        `import type { D } from '${TO_SRC}/types/webDemo.ts';\nexport const View = 1;`,
      );
      write('src/types/webDemo.ts', 'export type D = 1;');
      write('src/extensions/web.ts', entry);
      const metadata = {
        name: 'p',
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      };
      const files = ['dist', 'src/extensions/web.ts'];
      expect(webPluginManifest.check?.(writeManifest({ ...metadata, files }), root)).toContain(
        "the browser half imports 'src/types/webDemo.ts'",
      );
      const published = writeManifest({ ...metadata, files: [...files, 'src/types/webDemo.ts'] });
      expect(webPluginManifest.check?.(published, root)).toBeNull();
    });

    it('demands no browser tsconfig for a source client entry', () => {
      write('src/extensions/web.ts', entry);
      const manifest = writeManifest({
        name: 'p',
        files: ['dist', 'src/extensions/web.ts'],
        dependencies: { [CORE_PACKAGE]: 'workspace:*' },
        doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toBeNull();
    });

    it('rejects the removed nested browser entry in the manifest', () => {
      const manifest = writeManifest({
        name: 'p',
        doompiWeb: { pluginId: 'demo', client: './src/exports/extensions/web.ts' },
      });
      expect(webPluginManifest.check?.(manifest, root)).toContain(
        'client must be one of ./src/extensions/web.ts or ./dist/extensions/web.mjs',
      );
    });

    it('follows one re-export hop to validate the client entry', () => {
      writeManifest({ name: 'p', doompiWeb: { pluginId: 'demo', client: './src/extensions/web.ts' } });
      write(`${FRONTEND}/tab/demo.web.ts`, entry);
      const forwarding = write(
        'src/extensions/web.ts',
        "export { webPlugin } from './sessions/(frontend)/tab/demo.web';",
      );
      expect(webPluginEntry.check?.(forwarding, root)).toBeNull();

      write(`${FRONTEND}/tab/demo.web.ts`, "export const webPlugin = { id: 'demo' };");
      expect(webPluginEntry.check?.(forwarding, root)).toContain('must export webPlugin');
    });
  });
});
