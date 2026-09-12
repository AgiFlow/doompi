import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuleOptions } from '@agimon-ai/vibe-lint';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compatibilityWrapperOnly,
  cordisContextInPiAdapter,
  doomServerFacetShape,
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
    expect(doomFolderLayout.check?.(legacy, root, boundaryContext())).toContain('is forbidden');
  });

  it('rejects obsolete roots even when their names previously represented composition', () => {
    for (const folder of ['adapters', 'commands', 'container', 'containers', 'providers']) {
      const file = write(`src/${folder}/entry.ts`, 'export function entry() {}');
      expect(doomFolderLayout.check?.(file, root, boundaryContext())).toContain('Legacy root');
    }
    const deleted = path.join(root, 'src/adapters/deleted.ts');
    expect(doomFolderLayout.check?.(deleted, root, boundaryContext())).toBeNull();
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
    const privateFacade = write('src/bin/workerEntry.ts', "export * from './worker.ts';");

    expect(publicExportBoundary.check?.(publicFacade, root, boundaryContext())).toBeNull();
    expect(publicExportBoundary.check?.(serviceFacade, root, boundaryContext())).toContain('src/exports');
    expect(publicExportBoundary.check?.(privateFacade, root, boundaryContext())).toContain('src/exports');
  });

  it('does not classify local exports or executable runtime entries as pure re-exports', () => {
    const localExport = write('src/services/local.ts', 'const value = true; export { value };');
    const runtimeEntry = write(
      'src/bin/worker.ts',
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
    const command = write('src/controllers/run.ts', "import { nodeRun } from '../extensions/pi';");
    const adapter = write('src/extensions/pi.ts', "import { run } from '../services/run';");

    expect(doomLayerBoundary.check?.(command, root, boundaryContext())).toContain('forbidden dependencies');
    expect(doomLayerBoundary.check?.(adapter, root, boundaryContext())).toBeNull();
  });

  // src/web is the cockpit plugin's browser half. It is a canonical root so the
  // folder rules accept it and src/exports may publish its entry, and its only
  // inward dependency is the wire-JSON view types both halves share.
  it('accepts src/web as a canonical root and holds it to types and its own siblings', () => {
    write('package.json', JSON.stringify({ name: '@scope/package' }));
    const panel = write('src/web/DemoPanel.tsx', "import type { D } from '../types/webDemo.ts';");
    // A panel composes its siblings. Every other root may import itself, and web
    // is no different: without this a multi-file plugin fails the moment it moves
    // under src, which a single-file fixture never shows.
    const entry = write(
      'src/web/index.ts',
      ["import { DemoPanel } from './DemoPanel.tsx';", "import { fold } from './demoRender.ts';"].join('\n'),
    );
    const reaching = write('src/web/bad.ts', "import { run } from '../services/run.ts';");
    const client = write('src/exports/webClient.ts', "export { webPlugin } from '../web/index.ts';");

    expect(doomFolderLayout.check?.(panel, root, boundaryContext())).toBeNull();
    expect(doomLayerBoundary.check?.(panel, root, boundaryContext())).toBeNull();
    expect(doomLayerBoundary.check?.(entry, root, boundaryContext())).toBeNull();
    expect(doomLayerBoundary.check?.(reaching, root, boundaryContext())).toContain('forbidden dependencies');
    expect(doomLayerBoundary.check?.(client, root, boundaryContext())).toBeNull();
  });
  it('accepts the composed controller, model, tool, and service roots', () => {
    write('package.json', JSON.stringify({ name: '@scope/package' }));
    const model = write('src/models/session.ts', 'export const session = {};');
    const service = write(
      'src/services/session/index.ts',
      "import { createHash } from 'node:crypto'; export const digest = () => createHash('sha256');",
    );
    const controller = write(
      'src/controllers/session.ts',
      "import { digest } from '../services/session'; import { session } from '../models/session'; export { digest, session };",
    );
    const tool = write('src/tools/session.ts', "import { digest } from '../services/session'; export { digest };");
    for (const file of [model, service, controller, tool]) {
      expect(doomFolderLayout.check?.(file, root, boundaryContext())).toBeNull();
      expect(doomLayerBoundary.check?.(file, root, boundaryContext())).toBeNull();
    }
    expect(serviceBoundary.check?.(service, root, boundaryContext())).toBeNull();
  });
  it('allows TUI presentation to consume models without reversing their dependency', () => {
    const view = write(
      'src/tui/view.ts',
      "import { state } from '../models/state'; export const render = () => state;",
    );
    const model = write('src/models/state.ts', "import { render } from '../tui/view'; export const state = render();");
    expect(doomLayerBoundary.check?.(view, root, boundaryContext())).toBeNull();
    expect(doomLayerBoundary.check?.(model, root, boundaryContext())).toContain('forbidden dependencies');
  });

  it('allows a Cordis Service implementation without allowing a service-owned root', () => {
    const file = write(
      'src/services/config/index.ts',
      "import { Service } from '@deepseek-ai/cordis'; export class Config extends Service {}",
    );
    expect(serviceBoundary.check?.(file, root, boundaryContext())).toBeNull();
    const bootstrap = write(
      'src/services/bootstrap/index.ts',
      "import { Context } from '@deepseek-ai/cordis'; export const root = new Context();",
    );
    expect(noAmbientHostAccess.check?.(bootstrap, root, boundaryContext())).toContain('new Cordis Context');
  });

  it('allows verified Pi formatting utilities in services while rejecting host APIs and dynamic imports', () => {
    const utility = write(
      'src/services/read/index.ts',
      "import { CONFIG_DIR_NAME, loadSkillsFromDir, formatSkillsForPrompt, createSyntheticSourceInfo, getAgentDir, loadSkills, stripFrontmatter, truncateHead, formatSize, buildSessionContext, DEFAULT_COMPACTION_SETTINGS, generateSummary, sessionEntryToContextMessages, serializeConversation, isAssistantMessageWithUsage } from '@earendil-works/pi-coding-agent'; export const read = () => formatSize(1);",
    );
    expect(serviceBoundary.check?.(utility, root, boundaryContext())).toBeNull();
    fs.writeFileSync(
      utility,
      "import { createReadToolDefinition } from '@earendil-works/pi-coding-agent'; export const read = createReadToolDefinition('/tmp');",
    );
    expect(serviceBoundary.check?.(utility, root, boundaryContext())).toContain('forbidden dependencies');
    fs.writeFileSync(
      utility,
      "import { formatSize } from '@earendil-works/pi-coding-agent'; export const host = import('@earendil-works/pi-coding-agent');",
    );
    expect(serviceBoundary.check?.(utility, root, boundaryContext())).toContain('forbidden dependencies');
  });

  it('allows only the declared native persistence and package installation owners', () => {
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi' }));
    const owner = write(
      'src/services/layerPackageInstaller/index.ts',
      "import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'; export const manager = SettingsManager;",
    );
    expect(serviceBoundary.check?.(owner, root, boundaryContext())).toBeNull();
    const unrelated = write('src/services/other/index.ts', fs.readFileSync(owner, 'utf8'));
    expect(serviceBoundary.check?.(unrelated, root, boundaryContext())).toContain('forbidden dependencies');
    fs.writeFileSync(
      owner,
      "import { createAgentSession } from '@earendil-works/pi-coding-agent'; export const session = createAgentSession;",
    );
    expect(serviceBoundary.check?.(owner, root, boundaryContext())).toContain('forbidden dependencies');
    fs.writeFileSync(
      owner,
      "import { DefaultPackageManager } from '@earendil-works/pi-coding-agent'; export const manager = DefaultPackageManager;",
    );
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
    expect(serviceBoundary.check?.(owner, root, boundaryContext())).toContain('forbidden dependencies');
  });

  it('blocks service imports from adapters and containers', () => {
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
      'src/extensions/notifications.ts',
      [
        "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
        'export function notifications(_pi: ExtensionAPI): void {}',
      ].join('\n'),
    );

    expect(piExtensionDefaultFactory.check?.(entry, root, boundaryContext())).toContain('default factory');
  });

  it('accepts a named factory with a default host alias', () => {
    const entry = write(
      'src/extensions/notifications.ts',
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
      'src/extensions/pi.ts',
      ['const createExtension = (): (() => void) => () => {};', 'export default createExtension();'].join('\n'),
    );

    expect(piExtensionDefaultFactory.check?.(entry, root, boundaryContext())).toBeNull();
  });

  it('allows non-entry helpers beside host-loaded entries', () => {
    const helper = write(
      'src/extensions/shellTitleController.ts',
      'export function createShellTitleController(): object { return {}; }',
    );

    expect(piExtensionDefaultFactory.check?.(helper, root, boundaryContext())).toBeNull();
  });

  it('detects a missing default in current and legacy discovery source paths', () => {
    write(
      'package.json',
      JSON.stringify({
        pi: { extensions: ['./dist/extensions/pi.mjs'] },
        exports: { './extensions/pi': { import: './dist/extensions/pi.mjs' } },
      }),
    );
    const legacy = write('src/exports/extensions/pi.ts', 'export function activate(): void {}');
    const canonical = write('src/extensions/pi.ts', 'export function activate(): void {}');

    expect(piExtensionDefaultFactory.check?.(canonical, root, boundaryContext())).toContain('default factory');
    expect(piExtensionDefaultFactory.check?.(legacy, root, boundaryContext())).toContain('default factory');
  });

  it('derives thin Pi adapters from discovery metadata instead of a fixed path', () => {
    write('package.json', JSON.stringify({ pi: { extensions: ['./dist/extensions/custom.mjs'] } }));
    const entry = write('src/extensions/custom.ts', 'export interface RuntimeState {}');
    const helper = write('src/extensions/pi.ts', 'export interface RuntimeState {}');

    expect(thinPiAdapter.check?.(entry, root, boundaryContext())).toContain('too broad');
    expect(thinPiAdapter.check?.(helper, root, boundaryContext())).toBeNull();
  });

  it('rejects feature-package imports from DoomPi composition and honors custom package scopes', () => {
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi' }));
    const composition = write(
      'src/controllers/composition.ts',
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
      'src/services/mcpSessionEnvironment/index.ts',
      "import { sessionConfigEnvironment } from '@agimon-ai/doompi-mcp'; export { sessionConfigEnvironment };",
    );
    expect(doomCleanArchitectureBoundary.check?.(resourceAdapter, root, boundaryContext())).toBeNull();

    write('package.json', JSON.stringify({ name: '@scope/host' }));
    const customComposition = write(
      'src/controllers/customComposition.ts',
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

  it('lets the kernel package export its own vocabulary and still bans it elsewhere', () => {
    const abiViolation = (file: string): string =>
      doomCleanArchitectureBoundary.check?.(file, root, boundaryContext()) ?? '';

    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-kernel' }));
    const owned = write(
      'src/exports/index.ts',
      "export type { DoomKernel, KernelSlotSink } from '../types/kernel.ts';",
    );
    expect(abiViolation(owned)).not.toContain('public source exports native/Cordis ABI');

    // The owner is exempt for 'kernel' only, never for the rest of the ABI.
    const stillBanned = write('src/exports/index.ts', "export type { CordisRoot } from '../types/cordis.ts';");
    expect(abiViolation(stillBanned)).toContain('public source exports native/Cordis ABI');

    write('package.json', JSON.stringify({ name: '@scope/package' }));
    const borrowed = write('src/exports/index.ts', 'export interface KernelSlot { name: string }');
    expect(abiViolation(borrowed)).toContain('public source exports native/Cordis ABI');
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
        pi: { extensions: ['./dist/extensions/pi.mjs', './dist/extensions/extra.mjs'] },
      }),
    );
    write('src/extensions/pi.ts', 'export default function pi(): void {}');
    write('src/extensions/extra.ts', 'export default function extra(): void {}');

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
    it('allows services to own time, randomness, timers and process state', () => {
      const clock = write('src/services/expiry.ts', 'export const expired = (at: number) => at < Date.now();');
      const stamp = write('src/services/stamp.ts', 'export const stamp = () => new Date();');
      const timer = write('src/services/retry.ts', 'export const retry = (run: () => void) => setTimeout(run, 10);');
      const environment = write('src/services/mode.ts', 'export const mode = () => process.env.MODE;');
      const pure = write('src/services/expiryPure.ts', 'export const expired = (at: number, now: number) => at < now;');

      expect(noAmbientHostAccess.check?.(clock, root, boundaryContext())).toBeNull();
      expect(noAmbientHostAccess.check?.(stamp, root, boundaryContext())).toBeNull();
      expect(noAmbientHostAccess.check?.(timer, root, boundaryContext())).toBeNull();
      expect(noAmbientHostAccess.check?.(environment, root, boundaryContext())).toBeNull();
      expect(noAmbientHostAccess.check?.(pure, root, boundaryContext())).toBeNull();
    });

    it('rejects service-owned host bootstrap and native Pi registration', () => {
      const service = write(
        'src/services/session/index.ts',
        `
        import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
        import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
        export function start(pi: ExtensionAPI) { connectDoomCordisHost(pi, 'test'); pi.on('session_start', handler); }
      `,
      );
      expect(noAmbientHostAccess.check?.(service, root, boundaryContext())).toContain('connectDoomCordisHost');
      expect(noAmbientHostAccess.check?.(service, root, boundaryContext())).toContain('Pi.on');
    });

    it('ignores ambient reads outside src/services and in pure re-export modules', () => {
      const adapter = write('src/controllers/clock.ts', 'export const now = () => Date.now();');
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

    it('requires service folders and an index entry even for a single service', () => {
      const manifest = manifestWithServices('@agimon-ai/doompi-voice', {
        'src/services/voice/type.ts': 'export interface Voice { capture(): void }',
        'src/services/voice/capture.ts': 'export const capture = true;',
      });
      expect(flatServiceLayout.check?.(manifest, root, boundaryContext())).toContain('index.ts entry');
      write('src/services/voice/index.ts', 'export function capture() {}');
      expect(flatServiceLayout.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('rejects flat services and accepts several named service folders', () => {
      const manifest = manifestWithServices('@agimon-ai/doompi-plan', {
        'src/services/planner.ts': 'export const plan = true;',
      });
      expect(flatServiceLayout.check?.(manifest, root, boundaryContext())).toContain('Move flat service files');
      fs.unlinkSync(path.join(root, 'src/services/planner.ts'));
      write('src/services/history/index.ts', 'export const store = true;');
      write('src/services/runs/index.ts', 'export const queue = true;');
      expect(flatServiceLayout.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('stays quiet when the package declares no services at all', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-plan' }));
      expect(flatServiceLayout.check?.(manifest, root, boundaryContext())).toBeNull();
    });
  });

  describe('ports and forwarding', () => {
    it('requires service ports in a separate type contract', () => {
      const adapter = write(
        'src/services/historyStore/index.ts',
        'export interface IHistoryStore { read(): string }\nexport class HistoryStore implements IHistoryStore { read() { return ""; } }',
      );
      const implementation = write(
        'src/services/queueStore/index.ts',
        "import type { IQueueStore } from '../types/ports.ts';\nexport class QueueStore implements IQueueStore {}",
      );

      expect(portsDeclaredInTypes.check?.(adapter, root, boundaryContext())).toContain('Move IHistoryStore');
      expect(portsDeclaredInTypes.check?.(implementation, root, boundaryContext())).toBeNull();
    });

    it('accepts local service type contracts and shared types', () => {
      for (const location of ['src/services/history/type.ts', 'src/types/history.ts']) {
        const file = write(location, 'export interface IHistoryStore { read(): string }');
        expect(portsDeclaredInTypes.check?.(file, root, boundaryContext())).toBeNull();
      }
      const implementation = write(
        'src/services/history/index.ts',
        'export interface IHistoryStore { read(): string }',
      );
      expect(portsDeclaredInTypes.check?.(implementation, root, boundaryContext())).toContain('type.ts');
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
    it('allows exactly one Context in each shared host and rejects every package-local root', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-extension-contracts' }));
      const host = write(
        'src/controllers/cordisHost.ts',
        "import { Context } from '@deepseek-ai/cordis';\nconst root = new Context();",
      );
      const serverHost = write(
        'src/controllers/serverFacetLoader.ts',
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
      expect(cordisContextInPiAdapter.check?.(serverHost, root, boundaryContext())).toBeNull();
      expect(cordisContextInPiAdapter.check?.(manifest, root, boundaryContext())).toBeNull();
      expect(cordisContextInPiAdapter.check?.(container, root, boundaryContext())).toContain(
        'package-local Cordis root',
      );
      expect(cordisContextInPiAdapter.check?.(test, root, boundaryContext())).toBeNull();
    });

    it('reports a server facet loader that owns no Context or more than one', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-extension-contracts' }));
      write(
        'src/controllers/cordisHost.ts',
        "import { Context } from '@deepseek-ai/cordis';\nconst root = new Context();",
      );

      expect(cordisContextInPiAdapter.check?.(manifest, root, boundaryContext())).toContain(
        'src/controllers/serverFacetLoader.ts; found 0',
      );

      const serverHost = write(
        'src/controllers/serverFacetLoader.ts',
        "import { Context } from '@deepseek-ai/cordis';\nconst first = new Context();\nconst second = new Context();",
      );
      expect(cordisContextInPiAdapter.check?.(serverHost, root, boundaryContext())).toContain('exactly one');
      expect(cordisContextInPiAdapter.check?.(manifest, root, boundaryContext())).toContain('found 2');
    });

    it('requires the shared host cardinality and ignores non-Doom packages', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-extension-contracts' }));
      write(
        'src/controllers/serverFacetLoader.ts',
        "import { Context } from '@deepseek-ai/cordis';\nconst root = new Context();",
      );
      const host = write(
        'src/controllers/cordisHost.ts',
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

    it('accepts named declarations and rejects hand-written host leasing', () => {
      const manifest = featureManifest();
      const entry = write(
        'src/extensions/pi.ts',
        `import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension'; export default definePiExtension('@agimon-ai/doompi-example', () => ({ tools: [] }));`,
      );
      expect(cordisFeaturePlugin.check?.(entry, root, boundaryContext())).toBeNull();
      expect(cordisFeaturePlugin.check?.(manifest, root, boundaryContext())).toBeNull();
      fs.writeFileSync(entry, lifecycleSource());
      expect(cordisFeaturePlugin.check?.(entry, root, boundaryContext())).toContain('must use definePiExtension');
      expect(cordisFeaturePlugin.check?.(manifest, root, boundaryContext())).toContain('must use definePiExtension');
    });

    it('does not treat server and web exports as Pi discovery entries', () => {
      const manifest = write(
        'package.json',
        JSON.stringify({
          name: '@agimon-ai/doompi-example',
          exports: {
            './extensions/pi': './dist/extensions/pi.mjs',
            './extensions/server': './dist/extensions/server.mjs',
            './extensions/web': './src/extensions/web.ts',
          },
          pi: { extensions: ['./dist/extensions/pi.mjs'] },
        }),
      );
      write(
        'src/extensions/pi.ts',
        `import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension'; export default definePiExtension('demo', () => ({}));`,
      );
      const server = write(
        'src/extensions/server.ts',
        `import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet'; export default defineServerPlugin({ name: 'demo' });`,
      );
      const web = write('src/extensions/web.ts', `export const webPlugin = defineWebPlugin({ id: 'demo' });`);
      expect(cordisFeaturePlugin.check?.(manifest, root, boundaryContext())).toBeNull();
      expect(cordisFeaturePlugin.check?.(server, root, boundaryContext())).toBeNull();
      expect(cordisFeaturePlugin.check?.(web, root, boundaryContext())).toBeNull();
    });

    it('requires named helpers at every discovered feature entry', () => {
      const manifest = featureManifest();
      write(
        'src/extensions/pi.ts',
        `import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension'; export default definePiExtension('example', ({ context }) => ({ services: [(owner) => {}] }));`,
      );
      expect(cordisFeaturePlugin.check?.(manifest, root, boundaryContext())).toBeNull();
      fs.writeFileSync(
        path.join(root, 'src/extensions/pi.ts'),
        'export default function plugin(pi) { pi.registerTool(tool); }',
      );
      expect(cordisFeaturePlugin.check?.(manifest, root, boundaryContext())).toContain('must use definePiExtension');
    });

    it('retains cardinality and teardown-order checks for the host engine only', () => {
      featureManifest('@agimon-ai/doompi');
      const entry = write('src/extensions/modeCatalog.ts', lifecycleSource());
      expect(cordisFeaturePlugin.check?.(entry, root, boundaryContext())).toBeNull();
      fs.writeFileSync(
        entry,
        lifecycleSource().replace(
          'const fiber = connection.root.plugin(featurePlugin);',
          'const fiber = connection.root.plugin(featurePlugin); connection.root.plugin(other);',
        ),
      );
      expect(cordisFeaturePlugin.check?.(entry, root, boundaryContext())).toContain(
        'exactly one capturedConnection.root.plugin() call',
      );
      fs.writeFileSync(
        entry,
        lifecycleSource().replace(
          'try { await fiber.dispose(); } finally { await connection.dispose(); }',
          'try { await connection.dispose(); } finally { await fiber.dispose(); }',
        ),
      );
      expect(cordisFeaturePlugin.check?.(entry, root, boundaryContext())).toContain('fiber.dispose() before awaiting');
    });

    it('enforces the Doom host feature entries while exempting host/finalizer, tests, and unrelated packages', () => {
      const hostManifest = featureManifest('@agimon-ai/doompi');
      for (const [entry, factory] of [
        ['modeCatalog.ts', 'modeCatalogExtension'],
        ['styleSystem.ts', 'styleSystemVisuals'],
        ['transitionCoordinator.ts', 'transitionCoordinatorExtension'],
      ] as const) {
        write(`src/extensions/${entry}`, lifecycleSource(factory, '@agimon-ai/doompi'));
      }
      const host = write('src/extensions/cordisHost.ts', 'export function cordisHost(): void {}');
      const finalizer = write('src/extensions/cordisFinalizer.ts', 'export function finalizer(): void {}');
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
      const source = write('src/services/extensionAssembler/index.ts', assembler());
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
        'src/services/extensionAssembler/index.ts',
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

  it('limits generic helper host access to the contracts-owned controllers', () => {
    const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-extension-contracts' }));
    const source =
      "import { requireDoomServerHost } from '@agimon-ai/doompi-extension-contracts/server-facet'; export const mount = (context) => requireDoomServerHost(context);";
    write('src/controllers/serverPlugin.ts', source);
    expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
    expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toContain('has no owning');
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-extension-contracts' }));
    write('src/controllers/unowned.ts', source);
    expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toContain('has no owning');
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
        'src/extensions/extension.ts',
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

    it('accepts an object plugin that declares its own inject', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      write(
        'src/services/serverBinding/index.ts',
        [
          `import { DOOM_SERVER_HOST_SERVICE, requireDoomServerHost } from '@agimon-ai/doompi-extension-contracts/server-facet';`,
          `export const facet = {`,
          `  inject: [DOOM_SERVER_HOST_SERVICE],`,
          `  apply(context: unknown) {`,
          `    const host = requireDoomServerHost(context);`,
          `    const registration = host.registerApi(api);`,
          `    return () => registration.dispose();`,
          `  },`,
          `};`,
        ].join('\n'),
      );

      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('accepts an object plugin whose apply is an arrow property', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      write(
        'src/services/serverBinding/index.ts',
        [
          `import { DOOM_SERVER_HOST_SERVICE, requireDoomServerHost } from '@agimon-ai/doompi-extension-contracts/server-facet';`,
          `export const facet = {`,
          `  inject: [DOOM_SERVER_HOST_SERVICE],`,
          `  apply: (context: unknown) => {`,
          `    const host = requireDoomServerHost(context);`,
          `    const registration = host.registerApi(api);`,
          `    return () => registration.dispose();`,
          `  },`,
          `};`,
        ].join('\n'),
      );

      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('rejects an object plugin that uses a service it never injected', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      write(
        'src/services/serverBinding/index.ts',
        [
          `import { DOOM_SERVER_HOST_SERVICE, requireDoomServerHost } from '@agimon-ai/doompi-extension-contracts/server-facet';`,
          `export const facet = {`,
          `  apply(context: unknown) {`,
          `    const host = requireDoomServerHost(context);`,
          `    return () => host.dispose();`,
          `  },`,
          `};`,
        ].join('\n'),
      );

      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toContain(
        'has no owning ctx.inject dependency',
      );
    });
    it('recognizes owned contexts from named factories and services arrays', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      const entry = write(
        'src/extensions/pi.ts',
        `
        import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
        import { DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
        export default definePiExtension('example', ({ context: owner }) => {
          owner.provide(DOOM_HELP_SERVICE, help);
          return { services: [(context) => { context.provide(DOOM_HELP_SERVICE, help); }] };
        });
      `,
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();
      fs.writeFileSync(
        entry,
        `
        import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
        import { DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
        export default defineServerPlugin({ name: 'example', session: (plugin) => {
          plugin.context.provide(DOOM_HELP_SERVICE, help);
          return { services: [function provider(context) { context.provide(DOOM_HELP_SERVICE, help); }] };
        } });
      `,
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('follows an imported contribution factory into owned services', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      write(
        'src/extensions/pi.ts',
        `
        import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
        import { createRuntime } from '../controllers/runtime';
        export default definePiExtension('example', ({ pi }) => createRuntime({ pi }));
      `,
      );
      write(
        'src/controllers/runtime.ts',
        `
        import { DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
        export function createRuntime(options) {
          return { services: [(cordis) => { cordis.provide(DOOM_HELP_SERVICE, help); }] };
        }
      `,
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('follows a service method on a runtime returned by an imported factory', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      write(
        'src/extensions/pi.ts',
        `
        import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
        import { createRuntime } from '../services/runtime';
        export default definePiExtension('example', () => { const runtime = createRuntime(); return { services: [runtime.plugin] }; });
      `,
      );
      write(
        'src/services/runtime/index.ts',
        `
        import { DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
        export function createRuntime() { return { plugin(cordis) { cordis.provide(DOOM_HELP_SERVICE, help); } }; }
      `,
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();
    });

    it('does not exempt required-service reads merely because they appear in a named factory', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      write(
        'src/extensions/pi.ts',
        `
        import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
        import { requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
        export default definePiExtension('example', ({ context }) => {
          requireDoomHelpService(context);
          return {};
        });
      `,
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toContain(
        'has no owning ctx.inject dependency',
      );
    });

    it('does not grant ownership to legacy setup or arbitrary service-shaped objects', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      write(
        'src/extensions/pi.ts',
        `
        import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
        import { DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
        export default definePiExtension({ source: 'old', setup(context) { context.provide(DOOM_HELP_SERVICE, help); } });
        const unrelated = { services: [(context) => { context.provide(DOOM_HELP_SERVICE, help); }] };
      `,
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toContain(
        'provided outside a mounted plugin',
      );
    });

    it('requires providers to publish from a mounted plugin or injection-owned context', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-example' }));
      write(
        'src/extensions/owned.ts',
        [
          `import { DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';`,
          `connection.root.plugin(providerPlugin);`,
          `function providerPlugin(context: unknown) { installProvider(context); }`,
          `function installProvider(context: unknown) { context.provide(DOOM_HELP_SERVICE, service); }`,
        ].join('\n'),
      );
      expect(cordisServiceInjection.check?.(manifest, root, boundaryContext())).toBeNull();

      write(
        'src/extensions/unowned.ts',
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
        'src/extensions/extension.ts',
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
        'src/extensions/extension.ts',
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
        'src/extensions/extension.ts',
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
      write('src/extensions/extension.ts', `cordis.inject(['doom/config'], () => () => undefined);`);

      const result = cordisServiceInjection.check?.(manifest, root, boundaryContext());
      expect(result).toContain('DOOM_HELP_SERVICE has no owning ctx.inject dependency');
      expect(result).toContain('DOOM_VOICE_TOOLS_SERVICE has no owning ctx.inject dependency');
    });

    it('accepts a literal doom service read inside its literal owning injection', () => {
      const manifest = write('package.json', JSON.stringify({ name: '@agimon-ai/doompi-help' }));
      write(
        'src/extensions/extension.ts',
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

  it('recognizes only the core-owned HeadlessHost service and minor catalog providers', () => {
    write('package.json', JSON.stringify({ name: '@agimon-ai/doompi' }));
    const source = [
      `import { Context, Service } from '@deepseek-ai/cordis';`,
      `import { DOOM_HEADLESS_HOST_SERVICE } from '@agimon-ai/doompi-extension-contracts/headless';`,
      `import { DOOM_MINOR_MODE_CATALOG_SERVICE } from '@agimon-ai/doompi-extension-contracts/mode';`,
      `export class HeadlessHost extends Service<unknown> {`,
      `  constructor(context: Context) {`,
      `    super(context, DOOM_HEADLESS_HOST_SERVICE);`,
      `    context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, catalog);`,
      `  }`,
      `}`,
    ].join('\n');
    const native = write('src/controllers/headlessHost.ts', source);

    expect(cordisServiceInjection.check?.(path.join(root, 'package.json'), root, boundaryContext())).toBeNull();

    fs.rmSync(native);
    const wrongPath = write('src/controllers/otherHost.ts', source);
    const wrongPathResult = cordisServiceInjection.check?.(path.join(root, 'package.json'), root, boundaryContext());
    expect(wrongPathResult).toContain('DOOM_HEADLESS_HOST_SERVICE Service is constructed outside');
    expect(wrongPathResult).toContain('DOOM_MINOR_MODE_CATALOG_SERVICE is provided outside');

    fs.rmSync(wrongPath);
    write(
      'src/controllers/headlessHost.ts',
      source
        .replaceAll('DOOM_HEADLESS_HOST_SERVICE', 'DOOM_OTHER_SERVICE')
        .replaceAll('DOOM_MINOR_MODE_CATALOG_SERVICE', 'DOOM_OTHER_SERVICE'),
    );
    const wrongService = cordisServiceInjection.check?.(path.join(root, 'package.json'), root, boundaryContext());
    expect(wrongService).toContain('DOOM_OTHER_SERVICE Service is constructed outside');
    expect(wrongService).toContain('DOOM_OTHER_SERVICE is provided outside');

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@agimon-ai/doompi-host' }), 'utf8');
    fs.writeFileSync(path.join(root, 'src/controllers/headlessHost.ts'), source, 'utf8');
    const wrongPackage = cordisServiceInjection.check?.(path.join(root, 'package.json'), root, boundaryContext());
    expect(wrongPackage).toContain('DOOM_HEADLESS_HOST_SERVICE Service is constructed outside');
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
        'src/extensions/consumer.ts',
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
      const injected = write('src/extensions/consumer.ts', "ctx.inject(['doom/value'], plugin);");
      const unrelatedReflection = write('src/services/renderer.ts', 'renderer.reflect(light);');
      const unrelatedRoot = write('src/services/tree.ts', "const root = tree.root; root.reflect.get('branch');");
      const connectedReflection = write(
        'src/extensions/connected.ts',
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
        'src/extensions/injected.ts',
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
        '@earendil-works/pi-coding-agent': '0.85.1',
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

  describe('server facet shape', () => {
    it('accepts explicit scopes', () => {
      const file = write(
        'src/extensions/server.ts',
        'export const demoServerFacet = defineServerPlugin({ name: "demo", global: { channels: [createChannel] }, session: { api: [api] } });',
      );
      expect(doomServerFacetShape.check?.(file, root, boundaryContext())).toBeNull();
    });
    it('rejects raw lifecycle objects even without a type annotation', () => {
      const file = write('src/extensions/server.ts', 'export const demoServerFacet = { apply() {} };');
      expect(doomServerFacetShape.check?.(file, root, boundaryContext())).toContain('must use defineServerPlugin');
    });
    it('rejects legacy apply inside the helper', () => {
      const file = write(
        'src/extensions/server.ts',
        'export const demoServerFacet = defineServerPlugin({ apply() {} });',
      );
      expect(doomServerFacetShape.check?.(file, root, boundaryContext())).toContain('remove legacy apply');
    });
    it('rejects nested lifecycle delegation', () => {
      const file = write(
        'src/extensions/server.ts',
        'export const demoServerFacet = defineServerPlugin({ session: { commands(ctx) { oldFacet.apply(ctx); } } });',
      );
      expect(doomServerFacetShape.check?.(file, root, boundaryContext())).toContain('Do not nest facet.apply');
    });
    it('rejects the retired headless facet file', () => {
      const file = write('src/adapters/headless/facet.ts', 'export const oldFacet = {};');
      expect(doomServerFacetShape.check?.(file, root, boundaryContext())).toContain(
        'Remove the separate headless facet',
      );
    });
    it('ignores unrelated adapters', () => {
      const file = write('src/controllers/other.ts', 'export const demoServerFacet = { apply() {} };');
      expect(doomServerFacetShape.check?.(file, root, boundaryContext())).toBeNull();
    });
  });
});
