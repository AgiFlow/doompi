import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuleOptions } from '@agimon-ai/vibe-lint';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compatibilityWrapperOnly,
  cordisContextInPiAdapter,
  cordisFeaturePlugin,
  cordisHostOrder,
  cordisServiceInjection,
  doomCleanArchitectureBoundary,
  doomFolderLayout,
  doomLayerBoundary,
  flatServiceLayout,
  noAmbientHostAccess,
  noForwardingModule,
  noInternalPublicImport,
  noLegacyCordisAccess,
  packageLayerOrder,
  portsDeclaredInTypes,
  publicExportBoundary,
  schemaPlacement,
  serviceBoundary,
} from '../../src/rules/architecture.js';
import { doomPackageShape, thinPiAdapter } from '../../src/rules/conventions.js';
import { piExtensionDefaultFactory } from '../../src/rules/piExtensionContract.js';

function boundaryContext(options: RuleOptions = {}) {
  return { boundary: null, options };
}

describe('Doom deterministic architecture rules', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-architecture-'));
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

  it('accepts canonical roots and rejects implementation in legacy roots', () => {
    const service = write('src/services/runs/runService.ts', 'export const run = true;');
    const entry = write('src/exports/index.ts', "export { run } from '../services/runs/runService.ts';");
    const prompt = write('src/prompts/doompi-use-example/SKILL.md', '# Example\n');
    const legacy = write('src/runs/runService.ts', 'export const run = true;');

    expect(doomFolderLayout.check?.(service, root, boundaryContext())).toBeNull();
    expect(doomFolderLayout.check?.(entry, root, boundaryContext())).toBeNull();
    expect(doomFolderLayout.check?.(prompt, root, boundaryContext())).toBeNull();
    expect(doomFolderLayout.check?.(legacy, root, boundaryContext())).toContain('forwarding wrapper during migration');
  });

  it('treats prompts as a resource root in the package source vocabulary', () => {
    const manifest = write('package.json', JSON.stringify({ name: '@scope/package' }));
    write('src/prompts/doompi-use-example/SKILL.md', '# Example\n');

    expect(doomCleanArchitectureBoundary.check?.(manifest, root, boundaryContext())).toBeNull();
  });

  it('allows legacy public paths only when they forward exports during migration', () => {
    const wrapper = write('src/extension.ts', "export { registerExtension } from './extensions/pi.ts';");
    const implementation = write('src/extensionImpl.ts', 'export function registerExtension(): void {}');

    expect(compatibilityWrapperOnly.check?.(wrapper, root, boundaryContext())).toBeNull();
    expect(compatibilityWrapperOnly.check?.(implementation, root, boundaryContext())).toContain('only re-exports');
  });

  it('permits pure public facades only under src/exports', () => {
    const publicFacade = write('src/exports/index.ts', "export { run } from '../services/runService.ts';");
    const serviceFacade = write('src/services/index.ts', "export { run } from './runService.ts';");
    const privateFacade = write('src/adapters/process/workerEntry.ts', "export * from './worker.ts';");

    expect(publicExportBoundary.check?.(publicFacade, root, boundaryContext())).toBeNull();
    expect(publicExportBoundary.check?.(serviceFacade, root, boundaryContext())).toContain('src/exports');
    expect(publicExportBoundary.check?.(privateFacade, root, boundaryContext())).toContain('src/exports');
  });

  it('does not classify local exports or executable runtime entries as pure re-exports', () => {
    const localExport = write('src/services/local.ts', 'const value = true; export { value };');
    const runtimeEntry = write(
      'src/adapters/process/worker.ts',
      "import { parentPort } from 'node:worker_threads'; parentPort?.postMessage('ready');",
    );

    expect(publicExportBoundary.check?.(localExport, root, boundaryContext())).toBeNull();
    expect(publicExportBoundary.check?.(runtimeEntry, root, boundaryContext())).toBeNull();
  });

  it('blocks relative, dynamic, and package-self imports through public facades', () => {
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
    const service = write(
      'src/services/runService.ts',
      [
        "import { publicValue } from '../exports/index.ts';",
        "const later = import('../exports/runtime.ts');",
        "import type { PublicType } from '@agimon-ai/doompi-example/types';",
        'export { later, publicValue };',
      ].join('\n'),
    );

    expect(noInternalPublicImport.check?.(service, root, boundaryContext())).toContain('../exports/index.ts');
    expect(noInternalPublicImport.check?.(service, root, boundaryContext())).toContain(
      '@agimon-ai/doompi-example/types',
    );
  });

  it('enforces the canonical inward layer direction', () => {
    const command = write('src/commands/run.ts', "import { nodeRun } from '../adapters/process.ts';");
    const adapter = write('src/adapters/process.ts', "import { run } from '../services/run.ts';");

    expect(doomLayerBoundary.check?.(command, root, boundaryContext())).toContain('forbidden dependencies');
    expect(doomLayerBoundary.check?.(adapter, root, boundaryContext())).toBeNull();
  });

  it('blocks service imports from Node, Pi, adapters, containers, commands, extensions, and TUI', () => {
    const service = write(
      'src/services/runService.ts',
      [
        "import fs from 'node:fs';",
        "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
        "import { adapter } from '../adapters/runAdapter.ts';",
        "import { createContainer } from '../container/createContainer.ts';",
      ].join('\n'),
    );

    expect(serviceBoundary.check?.(service, root, boundaryContext())).toContain('forbidden dependencies');
  });

  it('permits service dependencies on services, types, schemas, and abstract external packages', () => {
    const service = write(
      'src/services/runService.ts',
      [
        "import type { Run } from '../types/run.ts';",
        "import { RunSchema } from '../schemas/run.ts';",
        "import { plan } from './planService.ts';",
        "import type { Logger } from '@agimon-ai/doompi-log';",
      ].join('\n'),
    );

    expect(serviceBoundary.check?.(service, root, boundaryContext())).toBeNull();
  });

  it('requires runtime schema construction under schemas', () => {
    const misplaced = write(
      'src/services/schema.ts',
      "import { Type } from 'typebox'; export const Run = Type.String();",
    );
    const canonical = write('src/schemas/run.ts', "import { Type } from 'typebox'; export const Run = Type.String();");

    expect(schemaPlacement.check?.(misplaced, root, boundaryContext())).toContain('src/schemas');
    expect(schemaPlacement.check?.(canonical, root, boundaryContext())).toBeNull();
  });

  it('requires a default factory for a host entry under src/exports', () => {
    const entry = write(
      'src/exports/entries/notifications.ts',
      [
        "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
        'export function notifications(_pi: ExtensionAPI): void {}',
      ].join('\n'),
    );

    expect(piExtensionDefaultFactory.check?.(entry, root, boundaryContext())).toContain('default factory');
  });

  it('accepts a named factory with a default host alias', () => {
    const entry = write(
      'src/exports/entries/notifications.ts',
      [
        "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
        'export function notifications(_pi: ExtensionAPI): void {}',
        'export { notifications as default };',
      ].join('\n'),
    );

    expect(piExtensionDefaultFactory.check?.(entry, root, boundaryContext())).toBeNull();
  });

  it('accepts a default factory returned by a factory creator', () => {
    write('package.json', JSON.stringify({ pi: { extensions: ['./dist/extensions/pi.mjs'] } }));
    const entry = write(
      'src/exports/extensions/pi.ts',
      ['const createExtension = (): (() => void) => () => {};', 'export default createExtension();'].join('\n'),
    );

    expect(piExtensionDefaultFactory.check?.(entry, root, boundaryContext())).toBeNull();
  });

  it('allows non-entry helpers beside host-loaded entries', () => {
    const helper = write(
      'src/exports/entries/shellTitleController.ts',
      'export function createShellTitleController(): object { return {}; }',
    );

    expect(piExtensionDefaultFactory.check?.(helper, root, boundaryContext())).toBeNull();
  });

  it('maps manifest runtime stems to new and transitional source paths', () => {
    write(
      'package.json',
      JSON.stringify({
        pi: { extensions: ['./dist/extensions/pi.mjs'] },
        exports: { './extensions/pi': { import: './dist/extensions/pi.mjs' } },
      }),
    );
    const canonical = write('src/exports/extensions/pi.ts', 'export function activate(): void {}');
    const transitional = write('src/extensions/pi.ts', 'export function activate(): void {}');

    expect(piExtensionDefaultFactory.check?.(canonical, root, boundaryContext())).toContain('default factory');
    expect(piExtensionDefaultFactory.check?.(transitional, root, boundaryContext())).toContain('default factory');
  });

  it('derives thin Pi adapters from discovery metadata instead of a fixed path', () => {
    write('package.json', JSON.stringify({ pi: { extensions: ['./dist/host/custom.mjs'] } }));
    const entry = write('src/exports/host/custom.ts', 'export interface RuntimeState {}');
    const helper = write('src/exports/extensions/pi.ts', 'export interface RuntimeState {}');

    expect(thinPiAdapter.check?.(entry, root, boundaryContext())).toContain('too broad');
    expect(thinPiAdapter.check?.(helper, root, boundaryContext())).toBeNull();
  });

  it('rejects feature-package imports from DoomPi composition and honors custom package scopes', () => {
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi' }));
    const composition = write(
      'src/adapters/composition.ts',
      [
        "import { loadModes } from '@agimon-ai/doompi-config/majorModes';",
        "import { run } from '@agimon-ai/doompi-runner';",
        'export { loadModes, run };',
      ].join('\n'),
    );

    expect(doomCleanArchitectureBoundary.check?.(composition, root, boundaryContext())).toContain(
      '@agimon-ai/doompi-runner',
    );

    const resourceAdapter = write(
      'src/adapters/mcpSessionEnvironment.ts',
      "import { sessionConfigEnvironment } from '@agimon-ai/doompi-mcp'; export { sessionConfigEnvironment };",
    );
    expect(doomCleanArchitectureBoundary.check?.(resourceAdapter, root, boundaryContext())).toBeNull();

    write('package.json', JSON.stringify({ name: '@scope/host' }));
    const customComposition = write(
      'src/adapters/customComposition.ts',
      "import { feature } from '@scope/feature-search'; export { feature };",
    );
    expect(
      doomCleanArchitectureBoundary.check?.(
        customComposition,
        root,
        boundaryContext({
          compositionPackages: ['@scope/host'],
          fixedCorePackages: ['@scope/host'],
          infrastructurePackages: [],
          featurePackagePrefixes: ['@scope/feature-'],
        }),
      ),
    ).toContain('@scope/feature-search');
  });

  it('rejects legacy extensions/doom files, exports, and build entries', () => {
    write('package.json', JSON.stringify({ name: '@scope/package' }));
    const legacySource = write('src/extensions/doom.ts', 'export default function legacy(): void {}');
    expect(doomCleanArchitectureBoundary.check?.(legacySource, root, boundaryContext())).toContain(
      'legacy extensions/doom file',
    );

    const manifest = write(
      'package.json',
      JSON.stringify({ name: '@scope/package', exports: { './extensions/doom': './dist/extensions/doom.mjs' } }),
    );
    expect(doomCleanArchitectureBoundary.check?.(manifest, root, boundaryContext())).toContain(
      'legacy extensions/doom export',
    );

    const buildConfig = write('tsdown.config.ts', "export default { entry: ['src/extensions/doom.ts'] };");
    expect(doomCleanArchitectureBoundary.check?.(buildConfig, root, boundaryContext())).toContain(
      'legacy extensions/doom build entry',
    );
  });

  it('rejects public native or Cordis ABI surfaces and doompi-capabilities references', () => {
    const manifest = write(
      'package.json',
      JSON.stringify({
        name: '@scope/package',
        exports: { './native-kernel': './dist/native-kernel.mjs' },
        dependencies: { '@agimon-ai/doompi-capabilities': '1.0.0' },
      }),
    );
    const manifestResult = doomCleanArchitectureBoundary.check?.(manifest, root, boundaryContext());
    expect(manifestResult).toContain('public native/Cordis ABI export');
    expect(manifestResult).toContain('doompi-capabilities');

    write('package.json', JSON.stringify({ name: '@scope/package' }));
    const publicSource = write('src/exports/index.ts', 'export interface NativeKernel { ready: boolean }');
    expect(doomCleanArchitectureBoundary.check?.(publicSource, root, boundaryContext())).toContain(
      'public source exports native/Cordis ABI',
    );
  });

  it('allows only the contracts package to publish the shared Cordis host boundary', () => {
    const contractsManifest = write(
      'package.json',
      JSON.stringify({
        name: '@agimon-ai/doompi-extension-contracts',
        exports: { './cordis-host': './dist/cordisHost.mjs' },
      }),
    );
    expect(doomCleanArchitectureBoundary.check?.(contractsManifest, root, boundaryContext())).toBeNull();

    const featureManifest = write(
      'package.json',
      JSON.stringify({
        name: '@agimon-ai/doompi-example',
        exports: { './cordis-host': './dist/cordisHost.mjs' },
      }),
    );
    expect(doomCleanArchitectureBoundary.check?.(featureManifest, root, boundaryContext())).toContain(
      'public native/Cordis ABI export',
    );
  });

  it('rejects fixed feature maps and feature declarations in foundation packages', () => {
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi' }));
    const fixedMap = write(
      'src/services/composition.ts',
      "const featureMap = { workflow: '@agimon-ai/doompi-workflow' }; export { featureMap };",
    );
    expect(doomCleanArchitectureBoundary.check?.(fixedMap, root, boundaryContext())).toContain(
      'fixed feature maps or slots',
    );

    const foundationManifest = write(
      'package.json',
      JSON.stringify({
        name: '@agimon-ai/doompi-extension-contracts',
        dependencies: { '@agimon-ai/doompi-task': '1.0.0' },
      }),
    );
    expect(doomCleanArchitectureBoundary.check?.(foundationManifest, root, boundaryContext())).toContain(
      'foundation package declares feature dependencies',
    );

    const foundationSource = write(
      'src/types/features.ts',
      'export const featurePackages = ["@agimon-ai/doompi-task"] as const;',
    );
    expect(doomCleanArchitectureBoundary.check?.(foundationSource, root, boundaryContext())).toContain(
      'foundation package declares fixed features',
    );
  });

  it('requires valid source-backed ordered pi.extensions targets while allowing multiple entries', () => {
    const manifest = write(
      'package.json',
      JSON.stringify({
        name: '@agimon-ai/doompi-example',
        pi: { extensions: ['./dist/extensions/pi.mjs', './dist/entries/extra.mjs'] },
      }),
    );
    write('src/extensions/pi.ts', 'export default function pi(): void {}');
    write('src/exports/entries/extra.ts', 'export default function extra(): void {}');

    expect(doomCleanArchitectureBoundary.check?.(manifest, root, boundaryContext())).toBeNull();

    fs.writeFileSync(manifest, JSON.stringify({ name: '@agimon-ai/doompi-example' }));
    expect(doomCleanArchitectureBoundary.check?.(manifest, root, boundaryContext())).toContain(
      'non-empty pi.extensions array',
    );

    fs.writeFileSync(
      manifest,
      JSON.stringify({
        name: '@agimon-ai/doompi-example',
        pi: { extensions: ['./dist/extensions/pi.js'] },
      }),
    );
    expect(doomCleanArchitectureBoundary.check?.(manifest, root, boundaryContext())).toContain(
      'invalid pi.extensions target',
    );

    fs.writeFileSync(
      manifest,
      JSON.stringify({
        name: '@agimon-ai/doompi-example',
        pi: { extensions: ['./dist/extensions/missing.mjs'] },
      }),
    );
    expect(doomCleanArchitectureBoundary.check?.(manifest, root, boundaryContext())).toContain('has no source entry');
  });

  it('requires a public publishable package shape and closed exports', () => {
    const valid = write(
      'package.json',
      JSON.stringify({
        name: '@agimon-ai/doompi-example',
        type: 'module',
        files: ['dist'],
        exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } },
        publishConfig: { access: 'public' },
      }),
    );
    expect(doomPackageShape.check?.(valid, root, boundaryContext())).toBeNull();

    fs.writeFileSync(
      valid,
      JSON.stringify({ private: true, type: 'module', files: ['dist'], exports: { './*': './dist/*' } }),
    );
    expect(doomPackageShape.check?.(valid, root, boundaryContext())).toContain('private: true is not allowed');
  });

  describe('service purity', () => {
    it('rejects ambient time, randomness, timers and process state in a service', () => {
      const clock = write('src/services/expiry.ts', 'export const expired = (at: number) => at < Date.now();');
      const stamp = write('src/services/stamp.ts', 'export const stamp = () => new Date();');
      const timer = write('src/services/retry.ts', 'export const retry = (run: () => void) => setTimeout(run, 10);');
      const environment = write('src/services/mode.ts', 'export const mode = () => process.env.MODE;');
      const pure = write('src/services/expiryPure.ts', 'export const expired = (at: number, now: number) => at < now;');

      expect(noAmbientHostAccess.check?.(clock, root, boundaryContext())).toContain('Date.now');
      expect(noAmbientHostAccess.check?.(stamp, root, boundaryContext())).toContain('new Date()');
      expect(noAmbientHostAccess.check?.(timer, root, boundaryContext())).toContain('setTimeout()');
      expect(noAmbientHostAccess.check?.(environment, root, boundaryContext())).toContain('process.env');
      expect(noAmbientHostAccess.check?.(pure, root, boundaryContext())).toBeNull();
    });

    it('ignores ambient reads outside src/services and in pure re-export modules', () => {
      const adapter = write('src/adapters/clock.ts', 'export const now = () => Date.now();');
      const facade = write('src/services/index.ts', "export { expired } from './expiry.ts';");

      expect(noAmbientHostAccess.check?.(adapter, root, boundaryContext())).toBeNull();
      expect(noAmbientHostAccess.check?.(facade, root, boundaryContext())).toBeNull();
    });
  });

  describe('service directory shape', () => {
    function manifestWithServices(name: string, tree: Record<string, string>): string {
      for (const [relativePath, source] of Object.entries(tree)) write(relativePath, source);
      return write('package.json', JSON.stringify({ name }));
    }

    it('rejects a services subdirectory that restates the package subject', () => {
      const manifest = manifestWithServices('@agimon-ai/doompi-voice', {
        'src/services/voice/capture.ts': 'export const capture = true;',
      });
      expect(flatServiceLayout.check?.(manifest, root, boundaryContext())).toContain(
        'src/services/voice restates the package subject',
      );
    });

    it('rejects a lone subdirectory that groups nothing', () => {
      const manifest = manifestWithServices('@agimon-ai/doompi-plan', {
        'src/services/history/store.ts': 'export const store = true;',
      });
      expect(flatServiceLayout.check?.(manifest, root, boundaryContext())).toContain('groups nothing');
    });

    it('accepts a flat services root and genuine multi-domain grouping', () => {
      const flat = manifestWithServices('@agimon-ai/doompi-plan', {
        'src/services/planner.ts': 'export const plan = true;',
      });
      expect(flatServiceLayout.check?.(flat, root, boundaryContext())).toBeNull();

      write('src/services/history/store.ts', 'export const store = true;');
      write('src/services/runs/queue.ts', 'export const queue = true;');
      expect(flatServiceLayout.check?.(flat, root, boundaryContext())).toBeNull();
    });

    it('stays quiet when the package declares no services at all', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-plan' }));
      expect(flatServiceLayout.check?.(manifest, root, boundaryContext())).toBeNull();
    });
  });

  describe('ports and forwarding', () => {
    it('rejects a port declared beside its adapter', () => {
      const adapter = write(
        'src/adapters/historyStore.ts',
        'export interface IHistoryStore { read(): string }\nexport class HistoryStore implements IHistoryStore { read() { return ""; } }',
      );
      const implementation = write(
        'src/adapters/queueStore.ts',
        "import type { IQueueStore } from '../types/ports.ts';\nexport class QueueStore implements IQueueStore {}",
      );

      expect(portsDeclaredInTypes.check?.(adapter, root, boundaryContext())).toContain('Move IHistoryStore');
      expect(portsDeclaredInTypes.check?.(implementation, root, boundaryContext())).toBeNull();
    });

    it('rejects a module that exists only to forward another', () => {
      const forwarder = write('src/services/legacyQueue.ts', "export * from './queue.ts';");
      const published = write('src/exports/queue.ts', "export * from '../services/queue.ts';");
      const real = write('src/services/queue.ts', 'export const queue = true;');

      expect(noForwardingModule.check?.(forwarder, root, boundaryContext())).toContain('only forwards another');
      expect(noForwardingModule.check?.(published, root, boundaryContext())).toBeNull();
      expect(noForwardingModule.check?.(real, root, boundaryContext())).toBeNull();
    });
  });

  describe('cordis Context ownership', () => {
    it('allows exactly one Context in the shared host and rejects every package-local root', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-extension-contracts' }));
      const host = write(
        'src/adapters/pi/cordisHost.ts',
        "import { Context } from '@deepseek-ai/cordis';\nconst root = new Context();",
      );
      const container = write(
        'src/container/index.ts',
        "import { Context } from '@deepseek-ai/cordis';\nconst cordis = new Context();",
      );
      const test = write(
        'tests/unit/harness.test.ts',
        "import { Context } from '@deepseek-ai/cordis';\nconst cordis = new Context();",
      );

      expect(cordisContextInPiAdapter.check?.(host, root, boundaryContext())).toBeNull();
      expect(cordisContextInPiAdapter.check?.(manifest, root, boundaryContext())).toBeNull();
      expect(cordisContextInPiAdapter.check?.(container, root, boundaryContext())).toContain(
        'package-local Cordis root',
      );
      expect(cordisContextInPiAdapter.check?.(test, root, boundaryContext())).toBeNull();
    });

    it('requires the shared host cardinality and ignores non-Doom packages', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-extension-contracts' }));
      const host = write(
        'src/adapters/pi/cordisHost.ts',
        "import { Context } from '@deepseek-ai/cordis';\nconst first = new Context();\nconst second = new Context();",
      );
      expect(cordisContextInPiAdapter.check?.(host, root, boundaryContext())).toContain('exactly one');
      expect(cordisContextInPiAdapter.check?.(manifest, root, boundaryContext())).toContain('found 2');

      const localContext = write('src/services/local.ts', 'class Context {}\nconst local = new Context();');
      expect(cordisContextInPiAdapter.check?.(localContext, root, boundaryContext())).toBeNull();

      const aliased = write(
        'src/services/aliased.ts',
        [
          `import { Context as CordisContext } from '@deepseek-ai/cordis';`,
          `const RuntimeContext = CordisContext;`,
          `const local = new RuntimeContext();`,
        ].join('\n'),
      );
      expect(cordisContextInPiAdapter.check?.(aliased, root, boundaryContext())).toContain('package-local Cordis root');

      const required = write(
        'src/services/required.ts',
        `const { Context: RuntimeContext } = require('@deepseek-ai/cordis');\nnew RuntimeContext();`,
      );
      expect(cordisContextInPiAdapter.check?.(required, root, boundaryContext())).toContain(
        'package-local Cordis root',
      );

      const namespaceAlias = write(
        'src/services/namespace.ts',
        [
          `import * as Cordis from '@deepseek-ai/cordis';`,
          `const Runtime = Cordis;`,
          `let RuntimeContext = Runtime.Context;`,
          `const Alias = RuntimeContext;`,
          `new Alias();`,
        ].join('\n'),
      );
      expect(cordisContextInPiAdapter.check?.(namespaceAlias, root, boundaryContext())).toContain(
        'package-local Cordis root',
      );

      write('package.json', JSON.stringify({ name: '@agimon-ai/unrelated' }));
      expect(cordisContextInPiAdapter.check?.(host, root, boundaryContext())).toBeNull();
    });
  });

  describe('Cordis feature mounting', () => {
    function featureManifest(name = '@agimon-ai/doompi-example'): string {
      const manifest = write(
        'package.json',
        JSON.stringify({
          name,
          exports: { './extensions/pi': './dist/extensions/pi.mjs' },
          pi: { extensions: ['./dist/extensions/pi.mjs'] },
        }),
      );
      write('src/exports/extensions/pi.ts', "export { extension as default } from '../../adapters/pi/extension.ts';");
      return manifest;
    }

    function lifecycleSource(factoryName = 'extension', packageName = '@agimon-ai/doompi-example'): string {
      return [
        `import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';`,
        `export async function ${factoryName}(pi: any) {`,
        `  const connection = await connectDoomCordisHost(pi, '${packageName}');`,
        `  const fiber = connection.root.plugin(featurePlugin);`,
        `  await fiber;`,
        `  let disposal: Promise<void> | undefined;`,
        `  pi.on('session_shutdown', () => (disposal ??= (async () => {`,
        `    try { await fiber.dispose(); } finally { await connection.dispose(); }`,
        `  })()));`,
        `}`,
      ].join('\n');
    }

    it('requires one captured host lease, one captured root fiber, and ordered shutdown disposal', () => {
      const manifest = featureManifest();
      write(
        'src/exports/extensions/pi.ts',
        [
          "export { extension as default } from '../../adapters/pi/extension.ts';",
          "export { activateRuntime } from '../../adapters/pi/runtimeActivation.ts';",
        ].join('\n'),
      );
      const adapter = write('src/adapters/pi/extension.ts', lifecycleSource());
      const helper = write('src/adapters/pi/helper.ts', 'export function helper(): void {}');
      write('src/adapters/pi/runtimeActivation.ts', 'export function activateRuntime(): void {}');

      expect(cordisFeaturePlugin.check?.(adapter, root, boundaryContext())).toBeNull();
      expect(cordisFeaturePlugin.check?.(helper, root, boundaryContext())).toBeNull();
      expect(cordisFeaturePlugin.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('rejects an uncaptured connector and missing root plugin and reports the package-wide absence', () => {
      const manifest = featureManifest();
      const adapter = write(
        'src/adapters/pi/extension.ts',
        [
          `import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';`,
          `export async function extension(pi: unknown) {`,
          `  await connectDoomCordisHost(pi, '@agimon-ai/doompi-example');`,
          `}`,
        ].join('\n'),
      );

      expect(cordisFeaturePlugin.check?.(adapter, root, boundaryContext())).toContain(
        'host connection must be captured',
      );
      expect(cordisFeaturePlugin.check?.(manifest, root, boundaryContext())).toContain('src/adapters/pi/extension.ts');
    });

    it('rejects duplicate leases, duplicate mounts, uncaptured fibers, and reversed shutdown ownership', () => {
      featureManifest();
      const duplicateLease = write(
        'src/adapters/pi/extension.ts',
        lifecycleSource().replace(
          `  const fiber = connection.root.plugin(featurePlugin);`,
          [
            `  const duplicate = await connectDoomCordisHost(pi, '@agimon-ai/doompi-example');`,
            `  const fiber = connection.root.plugin(featurePlugin);`,
          ].join('\n'),
        ),
      );
      expect(cordisFeaturePlugin.check?.(duplicateLease, root, boundaryContext())).toContain(
        'exactly one connectDoomCordisHost() call',
      );

      const duplicateMount = write(
        'src/adapters/pi/extension.ts',
        lifecycleSource().replace(
          `  const fiber = connection.root.plugin(featurePlugin);`,
          `  const fiber = connection.root.plugin(featurePlugin);\n  connection.root.plugin(secondPlugin);`,
        ),
      );
      expect(cordisFeaturePlugin.check?.(duplicateMount, root, boundaryContext())).toContain(
        'exactly one capturedConnection.root.plugin() call',
      );

      const uncapturedFiber = write(
        'src/adapters/pi/extension.ts',
        lifecycleSource().replace(
          `  const fiber = connection.root.plugin(featurePlugin);`,
          `  connection.root.plugin(featurePlugin);`,
        ),
      );
      expect(cordisFeaturePlugin.check?.(uncapturedFiber, root, boundaryContext())).toContain(
        'root.plugin() result must be captured',
      );

      const reversed = write(
        'src/adapters/pi/extension.ts',
        lifecycleSource().replace(
          `    try { await fiber.dispose(); } finally { await connection.dispose(); }`,
          `    try { await connection.dispose(); } finally { await fiber.dispose(); }`,
        ),
      );
      expect(cordisFeaturePlugin.check?.(reversed, root, boundaryContext())).toContain(
        'fiber.dispose() before awaiting the host connection.dispose()',
      );

      const reversedThroughHelpers = write(
        'src/adapters/pi/extension.ts',
        lifecycleSource()
          .replace(
            `  let disposal: Promise<void> | undefined;`,
            [
              `  const disposeFiber = async () => { await fiber.dispose(); };`,
              `  const disposeConnection = async () => { await connection.dispose(); };`,
              `  let disposal: Promise<void> | undefined;`,
            ].join('\n'),
          )
          .replace(
            `    try { await fiber.dispose(); } finally { await connection.dispose(); }`,
            `    await disposeConnection(); await disposeFiber();`,
          ),
      );
      expect(cordisFeaturePlugin.check?.(reversedThroughHelpers, root, boundaryContext())).toContain(
        'fiber.dispose() before awaiting the host connection.dispose()',
      );
    });

    it('follows a named shutdown event and a local cleanup callback', () => {
      featureManifest();
      const adapter = write(
        'src/adapters/pi/extension.ts',
        lifecycleSource()
          .replace(
            `  let disposal: Promise<void> | undefined;`,
            `  const SESSION_SHUTDOWN_EVENT = 'session_shutdown';\n  let disposal: Promise<void> | undefined;\n  const dispose = async () => {\n    try { await fiber.dispose(); } finally { await connection.dispose(); }\n  };`,
          )
          .replace(
            /  pi\.on\('session_shutdown',[\s\S]*?  \}\)\(\)\)\);/u,
            `  pi.on(SESSION_SHUTDOWN_EVENT, dispose);`,
          ),
      );

      expect(cordisFeaturePlugin.check?.(adapter, root, boundaryContext())).toBeNull();

      fs.writeFileSync(
        adapter,
        lifecycleSource()
          .replace(
            `  let disposal: Promise<void> | undefined;`,
            `  const disposeFiber = async () => { await fiber.dispose(); };\n  const dispose = async () => { disposeFiber(); await connection.dispose(); };\n  let disposal: Promise<void> | undefined;`,
          )
          .replace(/  pi\.on\('session_shutdown',[\s\S]*?  \}\)\(\)\)\);/u, `  pi.on('session_shutdown', dispose);`),
      );
      expect(cordisFeaturePlugin.check?.(adapter, root, boundaryContext())).toContain(
        'fiber.dispose() before awaiting the host connection.dispose()',
      );

      fs.writeFileSync(
        adapter,
        lifecycleSource()
          .replace(
            `  let disposal: Promise<void> | undefined;`,
            [
              `  let disposal: Promise<void> | undefined;`,
              `  const dispose = (): Promise<void> => {`,
              `    if (disposal) return disposal;`,
              `    disposal = fence.runCleanup(async () => {`,
              `      try { await fiber.dispose(); } finally { await connection.dispose(); }`,
              `    });`,
              `    return disposal;`,
              `  };`,
            ].join('\n'),
          )
          .replace(/  pi\.on\('session_shutdown',[\s\S]*?  \}\)\(\)\)\);/u, `  pi.on('session_shutdown', dispose);`),
      );
      expect(cordisFeaturePlugin.check?.(adapter, root, boundaryContext())).toBeNull();
    });

    it('checks each independently exported feature adapter rather than limiting a package to one', () => {
      const manifest = featureManifest();
      write(
        'package.json',
        JSON.stringify({
          name: '@agimon-ai/doompi-example',
          exports: {
            './extensions/persona': './dist/extensions/persona.mjs',
            './extensions/pi': './dist/extensions/pi.mjs',
          },
          pi: { extensions: ['./dist/extensions/pi.mjs'] },
        }),
      );
      write('src/exports/extensions/persona.ts', "export { persona as default } from '../../adapters/pi/persona.ts';");
      for (const [fileName, factoryName] of [
        ['extension.ts', 'extension'],
        ['persona.ts', 'persona'],
      ] as const) {
        write(`src/adapters/pi/${fileName}`, lifecycleSource(factoryName));
      }

      expect(cordisFeaturePlugin.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('enforces the Doom host feature entries while exempting host/finalizer, tests, and unrelated packages', () => {
      const hostManifest = featureManifest('@agimon-ai/doompi');
      for (const [entry, factory] of [
        ['modeCatalog.ts', 'modeCatalogExtension'],
        ['styleSystem.ts', 'styleSystemVisuals'],
        ['transitionCoordinator.ts', 'transitionCoordinatorExtension'],
      ] as const) {
        write(`src/extensions/entries/${entry}`, lifecycleSource(factory, '@agimon-ai/doompi'));
      }
      const host = write('src/extensions/entries/cordisHost.ts', 'export function cordisHost(): void {}');
      const finalizer = write('src/extensions/entries/cordisFinalizer.ts', 'export function finalizer(): void {}');
      const test = write('tests/extension.test.ts', 'connection.root.plugin(plugin);');
      expect(cordisFeaturePlugin.check?.(hostManifest, root, boundaryContext())).toBeNull();
      expect(cordisFeaturePlugin.check?.(host, root, boundaryContext())).toBeNull();
      expect(cordisFeaturePlugin.check?.(finalizer, root, boundaryContext())).toBeNull();
      expect(cordisFeaturePlugin.check?.(test, root, boundaryContext())).toBeNull();

      const unrelatedManifest = featureManifest('@agimon-ai/unrelated');
      expect(cordisFeaturePlugin.check?.(unrelatedManifest, root, boundaryContext())).toBeNull();
    });
  });

  describe('Cordis host activation order', () => {
    function assembler(parentTail = 'cordisFinalizer', childTail = 'cordisFinalizer'): string {
      return [
        `function parentActivation() {`,
        `  const resolve = context.resolvers;`,
        `  const activation = [resolve.ownEntry(OWN_ENTRIES.cordisHost), feature];`,
        `  activation.push(resolve.ownEntry(OWN_ENTRIES.${parentTail}));`,
        `  return deduplicatePaths(activation);`,
        `}`,
        `function childActivation() {`,
        `  const resolve = context.resolvers;`,
        `  const activation = [resolve.ownEntry(OWN_ENTRIES.cordisHost), feature];`,
        `  activation.push(resolve.ownEntry(OWN_ENTRIES.${childTail}));`,
        `  return deduplicatePaths(activation);`,
        `}`,
      ].join('\n');
    }

    it('requires host-first and finalizer-last for parent and detached-child activation', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi' }));
      const source = write('src/services/extensionAssembler.ts', assembler());
      expect(cordisHostOrder.check?.(manifest, root, boundaryContext())).toBeNull();
      expect(cordisHostOrder.check?.(source, root, boundaryContext())).toBeNull();

      fs.writeFileSync(source, assembler('featureEntry', 'featureEntry'));
      expect(cordisHostOrder.check?.(source, root, boundaryContext())).toContain(
        'parentActivation() must contain cordisFinalizer exactly once',
      );
      expect(cordisHostOrder.check?.(source, root, boundaryContext())).toContain(
        'childActivation() must append cordisFinalizer',
      );
    });

    it('rejects duplicate hosts and a finalizer followed by another activation', () => {
      write('package.json', JSON.stringify({ name: '@agimon-ai/doompi' }));
      const source = write(
        'src/services/extensionAssembler.ts',
        assembler()
          .replace(
            'const activation = [resolve.ownEntry(OWN_ENTRIES.cordisHost), feature];',
            'const activation = [resolve.ownEntry(OWN_ENTRIES.cordisHost), resolve.ownEntry(OWN_ENTRIES.cordisHost)];',
          )
          .replace(
            'activation.push(resolve.ownEntry(OWN_ENTRIES.cordisFinalizer));',
            'activation.push(resolve.ownEntry(OWN_ENTRIES.cordisFinalizer));\n  activation.push(feature);',
          ),
      );
      const result = cordisHostOrder.check?.(source, root, boundaryContext());
      expect(result).toContain('parentActivation() must contain cordisHost exactly once');
      expect(result).toContain('parentActivation() must append cordisFinalizer after every other activation');

      fs.writeFileSync(
        source,
        assembler().replaceAll(
          'return deduplicatePaths(activation);',
          'activation.reverse(); return deduplicatePaths(activation);',
        ),
      );
      expect(cordisHostOrder.check?.(source, root, boundaryContext())).toContain(
        'mutates activation outside append-only push',
      );

      fs.writeFileSync(
        source,
        assembler().replaceAll(
          'return deduplicatePaths(activation);',
          'mutateActivation(activation); return deduplicatePaths(activation);',
        ),
      );
      expect(cordisHostOrder.check?.(source, root, boundaryContext())).toContain('alias/escape');
    });
  });

  describe('Cordis required-service injection', () => {
    it('accepts a stable Pi wrapper created and cleared by its owning injected callback', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-hook' }));
      write(
        'src/services/hookSession.ts',
        [
          `import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';`,
          `export const config = (cordis: unknown) => requireDoomConfigContext(cordis);`,
        ].join('\n'),
      );
      write(
        'src/adapters/pi/extension.ts',
        [
          `import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';`,
          `let runtime: unknown;`,
          `cordis.inject([DOOM_CONFIG_SERVICE], (context) => {`,
          `  const binding = createRuntime(context);`,
          `  runtime = binding;`,
          `  context.effect(() => () => { if (runtime === binding) runtime = undefined; });`,
          `});`,
        ].join('\n'),
      );

      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('requires providers to publish from a mounted plugin or injection-owned context', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      write(
        'src/adapters/pi/owned.ts',
        [
          `import { DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';`,
          `connection.root.plugin(providerPlugin);`,
          `function providerPlugin(context: unknown) { installProvider(context); }`,
          `function installProvider(context: unknown) { context.provide(DOOM_HELP_SERVICE, service); }`,
        ].join('\n'),
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();

      write(
        'src/adapters/pi/unowned.ts',
        [
          `import { DOOM_NARRATION_SERVICE } from '@agimon-ai/doompi-extension-contracts/narration';`,
          `connection.root.provide(DOOM_NARRATION_SERVICE, service);`,
        ].join('\n'),
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toContain(
        'DOOM_NARRATION_SERVICE is provided outside a mounted plugin or injection-owned context',
      );
    });

    it('does not mistake eager clears or escaped nested closures for provider-loss cleanup', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      const source = write(
        'src/adapters/pi/extension.ts',
        [
          `import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';`,
          `let active: unknown;`,
          `export const use = (context: unknown) => requireDoomHelpService(context);`,
          `cordis.inject([DOOM_HELP_SERVICE], (context) => {`,
          `  const binding = createBinding(context);`,
          `  active = binding;`,
          `  active = undefined;`,
          `  return () => undefined;`,
          `});`,
        ].join('\n'),
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toContain(
        'does not establish and clear an active binding',
      );

      fs.writeFileSync(
        source,
        [
          `import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';`,
          `let escaped: (() => unknown) | undefined;`,
          `cordis.inject([DOOM_HELP_SERVICE], (context) => {`,
          `  escaped = () => requireDoomHelpService(context);`,
          `  return () => undefined;`,
          `});`,
        ].join('\n'),
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toContain(
        'does not establish and clear an active binding',
      );

      fs.writeFileSync(
        source,
        [
          `import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';`,
          `let active: unknown;`,
          `export const use = (context: unknown) => requireDoomHelpService(context);`,
          `cordis.inject([DOOM_HELP_SERVICE], (context) => {`,
          `  const binding = createBinding(context);`,
          `  active = binding;`,
          `  return () => { if (active === binding) observe(); active = undefined; };`,
          `});`,
        ].join('\n'),
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toContain(
        'does not establish and clear an active binding',
      );
    });

    it('reports required services omitted from inject and dependencies that do not clear a stable binding', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-hook' }));
      write(
        'src/commands/run.ts',
        [
          `import { requireDoomTransitionCoordinator } from '@agimon-ai/doompi-extension-contracts/transition';`,
          `import { requireDoomReadinessCoordinator } from '@agimon-ai/doompi-extension-contracts/readiness';`,
          `export function run(ctx: unknown) {`,
          `  requireDoomTransitionCoordinator(ctx);`,
          `  requireDoomReadinessCoordinator(ctx);`,
          `}`,
        ].join('\n'),
      );
      write(
        'src/adapters/pi/extension.ts',
        [
          `import { DOOM_TRANSITION_SERVICE } from '@agimon-ai/doompi-extension-contracts/transition';`,
          `cordis.inject([DOOM_TRANSITION_SERVICE], () => { return () => undefined; });`,
        ].join('\n'),
      );

      const result = cordisServiceInjection.check?.(manifest, root, boundaryContext());
      expect(result).toContain('DOOM_READINESS_SERVICE has no owning ctx.inject dependency');
      expect(result).toContain(
        'DOOM_TRANSITION_SERVICE does not establish and clear an active binding for stable Pi wrappers',
      );
    });

    it('accepts direct required use inside a lifecycle-owned inject callback', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-ui' }));
      write(
        'src/adapters/pi/extension.ts',
        [
          `import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';`,
          `cordis.inject([DOOM_UI_HUB_SERVICE], (context) => {`,
          `  const handle = requireDoomUiHub(context).registerLeader(contribution);`,
          `  return () => handle.dispose();`,
          `});`,
        ].join('\n'),
      );

      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('infers every requireDoom helper and rejects literal doom service reads without inject ownership', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-help' }));
      write(
        'src/services/help.ts',
        [
          `import { requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';`,
          `export function required(ctx: unknown) { return requireDoomHelpService(ctx); }`,
          `export function literal(ctx: any) { return ctx.get('doom/voice-tools'); }`,
        ].join('\n'),
      );
      write('src/adapters/pi/extension.ts', `cordis.inject(['doom/config'], () => () => undefined);`);

      const result = cordisServiceInjection.check?.(manifest, root, boundaryContext());
      expect(result).toContain('DOOM_HELP_SERVICE has no owning ctx.inject dependency');
      expect(result).toContain('DOOM_VOICE_TOOLS_SERVICE has no owning ctx.inject dependency');
    });

    it('accepts a literal doom service read inside its literal owning injection', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-help' }));
      write(
        'src/adapters/pi/extension.ts',
        [
          `cordis.inject(['doom/help'], (context) => {`,
          `  const help = context.get('doom/help');`,
          `  return () => help.dispose();`,
          `});`,
        ].join('\n'),
      );

      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();
    });
  });

  describe('legacy Cordis access', () => {
    it('rejects the legacy export, imports, modules, and reflection in Doom production source', () => {
      const manifest = write(
        'package.json',
        JSON.stringify({
          name: '@agimon-ai/doompi-extension-contracts',
          exports: { './session-context': './dist/sessionContext.mjs' },
        }),
      );
      const legacyModule = write('src/schemas/sessionContext.ts', 'export const legacy = true;');
      const consumer = write(
        'src/adapters/pi/consumer.ts',
        [
          `import { readDoomSessionContext } from '@agimon-ai/doompi-extension-contracts/session-context';`,
          `import type { Context as CordisContext } from '@deepseek-ai/cordis';`,
          `function read(ctx: CordisContext) { const sessionContext = ctx; return sessionContext.reflect.get('doom/value'); }`,
        ].join('\n'),
      );

      expect(noLegacyCordisAccess.check?.(manifest, root, boundaryContext())).toContain('./session-context');
      expect(noLegacyCordisAccess.check?.(legacyModule, root, boundaryContext())).toContain(
        'legacy session-context module',
      );
      expect(noLegacyCordisAccess.check?.(consumer, root, boundaryContext())).toContain(
        'legacy @agimon-ai/doompi-extension-contracts/session-context import and Cordis reflect access',
      );

      fs.rmSync(legacyModule);
      expect(noLegacyCordisAccess.check?.(legacyModule, root, boundaryContext())).toBeNull();
    });

    it('allows injected access and ignores tests and non-Doom packages', () => {
      write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      const injected = write('src/adapters/pi/consumer.ts', "ctx.inject(['doom/value'], plugin);");
      const unrelatedReflection = write('src/services/renderer.ts', 'renderer.reflect(light);');
      const unrelatedRoot = write('src/services/tree.ts', "const root = tree.root; root.reflect.get('branch');");
      const connectedReflection = write(
        'src/adapters/pi/connected.ts',
        [
          `import { connectDoomCordisHost as connect } from '@agimon-ai/doompi-extension-contracts/cordis-host';`,
          `async function read(pi: unknown) {`,
          `  const connection = await connect(pi, 'fixture');`,
          `  const { root: sessionContext } = connection;`,
          `  return sessionContext['reflect'].get('doom/value');`,
          `}`,
        ].join('\n'),
      );
      const injectedReflection = write(
        'src/adapters/pi/injected.ts',
        [
          `import * as Cordis from '@deepseek-ai/cordis';`,
          `function read(root: Cordis.Context) {`,
          `  const context = root.root;`,
          `  context.inject(['doom/value'], (injected) => injected.reflect.get('doom/value'));`,
          `}`,
        ].join('\n'),
      );
      const test = write('tests/reflect.test.ts', "root.reflect.get('fixture');");
      expect(noLegacyCordisAccess.check?.(injected, root, boundaryContext())).toBeNull();
      expect(noLegacyCordisAccess.check?.(unrelatedReflection, root, boundaryContext())).toBeNull();
      expect(noLegacyCordisAccess.check?.(unrelatedRoot, root, boundaryContext())).toBeNull();
      expect(noLegacyCordisAccess.check?.(connectedReflection, root, boundaryContext())).toContain(
        'Cordis reflect access',
      );
      expect(noLegacyCordisAccess.check?.(injectedReflection, root, boundaryContext())).toContain(
        'Cordis reflect access',
      );
      expect(noLegacyCordisAccess.check?.(test, root, boundaryContext())).toBeNull();

      write('package.json', JSON.stringify({ name: '@agimon-ai/unrelated' }));
      const unrelated = write('src/runtime.ts', "root.reflect.get('value');");
      expect(noLegacyCordisAccess.check?.(unrelated, root, boundaryContext())).toBeNull();
    });
  });

  describe('package tier ordering', () => {
    function manifestFor(name: string, dependencies: Record<string, string> = {}): string {
      return write('package.json', JSON.stringify({ name, dependencies }));
    }

    it('allows a package to depend on its own tier and every tier below it', () => {
      const manifest = manifestFor('@agimon-ai/doompi-autocompact', {
        '@agimon-ai/doompi-config': 'workspace:*',
        '@agimon-ai/doompi-extension-contracts': 'workspace:*',
        '@agimon-ai/doompi-task': 'workspace:*',
        '@agimon-ai/doompi-ui': 'workspace:*',
      });
      expect(packageLayerOrder.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('rejects the platform tier depending on an extension', () => {
      const manifest = manifestFor('@agimon-ai/doompi-config', { '@agimon-ai/doompi-voice': 'workspace:*' });
      expect(packageLayerOrder.check?.(manifest, root, boundaryContext())).toContain(
        '@agimon-ai/doompi-config is a platform package and depends on a higher tier: @agimon-ai/doompi-voice',
      );
    });

    it('names the nx cycle when an extension reaches for the host', () => {
      const manifest = manifestFor('@agimon-ai/doompi-domain', { '@agimon-ai/doompi': 'workspace:*' });
      expect(packageLayerOrder.check?.(manifest, root, boundaryContext())).toContain(
        'makes the nx project graph cyclic',
      );
    });

    it('catches an upward import that the manifest never declared', () => {
      manifestFor('@agimon-ai/doompi-ui');
      const source = write('src/tui/matrixPicker.ts', "import { applyDomains } from '@agimon-ai/doompi/services';");
      expect(packageLayerOrder.check?.(source, root, boundaryContext())).toContain('@agimon-ai/doompi');
    });

    it('leaves the host and unranked packages alone', () => {
      const host = manifestFor('@agimon-ai/doompi', {
        '@agimon-ai/doompi-voice': 'workspace:*',
        '@earendil-works/pi-coding-agent': '0.84.3',
      });
      expect(packageLayerOrder.check?.(host, root, boundaryContext())).toBeNull();

      const unranked = manifestFor('@agimon-ai/mcp-proxy', { '@agimon-ai/doompi': 'workspace:*' });
      expect(packageLayerOrder.check?.(unranked, root, boundaryContext())).toBeNull();
    });
  });

  describe('fixed core dependency declarations', () => {
    it('requires the composition package to depend on fixed core packages that exist beside it', () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-workspace-'));
      const hostRoot = path.join(workspace, 'doompi');
      const coreRoot = path.join(workspace, 'doompi-domain');
      for (const directory of [hostRoot, coreRoot]) fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(coreRoot, 'package.json'),
        JSON.stringify({ name: '@agimon-ai/doompi-domain', pi: { extensions: ['./dist/extensions/pi.mjs'] } }),
      );
      const hostManifest = path.join(hostRoot, 'package.json');
      const writeHost = (dependencies: Record<string, string>): void => {
        fs.writeFileSync(hostManifest, JSON.stringify({ name: '@agimon-ai/doompi', dependencies }));
      };

      writeHost({});
      expect(doomCleanArchitectureBoundary.check?.(hostManifest, hostRoot, boundaryContext())).toContain(
        'fixed core packages missing from dependencies: @agimon-ai/doompi-domain',
      );

      writeHost({ '@agimon-ai/doompi-domain': 'workspace:*' });
      const declared = doomCleanArchitectureBoundary.check?.(hostManifest, hostRoot, boundaryContext());
      expect(declared ?? '').not.toContain('fixed core packages missing');

      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('stays quiet about fixed core packages a migration has not created yet', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi', dependencies: {} }));
      const violations = doomCleanArchitectureBoundary.check?.(manifest, root, boundaryContext());
      expect(violations ?? '').not.toContain('fixed core packages missing');
    });
  });
});
