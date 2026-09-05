import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disposeExternalSubscriptions,
  doomPackageShape,
  noLiveGlobalRegistry,
  noProtocolChannelLiterals,
  noRawPiEvents,
  noSameRunnerProtocol,
  piPeerVersion,
  preferCordisContainer,
  providerOwnedPolicy,
  thinPiAdapter,
} from '../../src/rules/conventions.js';

const boundaryContext = () => ({ boundary: null });

describe('Doom package convention rules', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-conventions-'));
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

  it('reports every invalid publishable package attribute', () => {
    const manifest = writeManifest({
      private: true,
      type: 'commonjs',
      files: [],
      exports: { './*': './dist/*.js' },
      publishConfig: { access: 'restricted' },
    });

    const result = doomPackageShape.check?.(manifest, root, boundaryContext());

    expect(result).toContain('private: true is not allowed');
    expect(result).toContain('type must be module');
    expect(result).toContain('files publish allowlist is required');
    expect(result).toContain('publishConfig.access must be public');
    expect(result).toContain('wildcard exports are not allowed');
  });

  it('allows the explicit private unreleased Author package without weakening other shape checks', () => {
    const manifest = writeManifest({
      name: '@agimon-ai/doompi-author',
      private: true,
      type: 'module',
      files: ['dist'],
      exports: { '.': './dist/index.mjs' },
    });

    expect(doomPackageShape.check?.(manifest, root, boundaryContext())).toBeNull();
  });
  it('ignores non-manifest files and absent manifests', () => {
    const source = write('src/services/run.ts', 'export const run = true;');

    expect(doomPackageShape.check?.(source, root, boundaryContext())).toBeNull();
    expect(doomPackageShape.check?.(path.join(root, 'package.json'), root, boundaryContext())).toBeNull();
  });

  it('requires exact Pi dependency pins while allowing unrelated manifests', () => {
    const manifest = writeManifest({
      peerDependencies: {
        '@earendil-works/pi-coding-agent': '^0.85.0',
        '@earendil-works/pi-tui': '0.85.0',
      },
      devDependencies: {
        '@earendil-works/pi-tui': '0.84.0',
      },
    });

    expect(piPeerVersion.check?.(manifest, root, boundaryContext())).toContain(
      '@earendil-works/pi-coding-agent, @earendil-works/pi-tui',
    );

    fs.writeFileSync(
      manifest,
      JSON.stringify({
        peerDependencies: { '@earendil-works/pi-coding-agent': '0.85.0' },
        devDependencies: { '@earendil-works/pi-coding-agent': '0.85.0' },
      }),
    );
    expect(piPeerVersion.check?.(manifest, root, boundaryContext())).toBeNull();
    expect(piPeerVersion.check?.(write('README.md', 'docs'), root, boundaryContext())).toBeNull();
  });

  it('forbids Team from declaring or importing Inversify and reflect-metadata', () => {
    const manifest = writeManifest({
      name: '@agimon-ai/doompi-team',
      dependencies: { inversify: '7.10.4', 'reflect-metadata': '0.2.2' },
    });
    const container = write(
      'src/container/index.ts',
      "import 'reflect-metadata';\nimport { Container } from 'inversify';\nexport const container = new Container();",
    );

    expect(preferCordisContainer.check?.(manifest, root, boundaryContext())).toContain(
      'inversify and reflect-metadata',
    );
    expect(preferCordisContainer.check?.(container, root, boundaryContext())).toContain('cordis Context');
  });

  it('does not apply the Doom container rule to tests or non-Doom packages', () => {
    writeManifest({ name: '@agimon-ai/doompi-team' });
    const test = write('tests/container.test.ts', "import { Container } from 'inversify';");
    expect(preferCordisContainer.check?.(test, root, boundaryContext())).toBeNull();

    writeManifest({ name: '@agimon-ai/unrelated', dependencies: { inversify: '7.10.4' } });
    const source = write('src/container/index.ts', "import { Container } from 'inversify';");
    expect(preferCordisContainer.check?.(source, root, boundaryContext())).toBeNull();
  });

  it('checks only manifest-declared Pi entry modules for thinness', () => {
    writeManifest({ pi: { extensions: ['./dist/extensions/pi.mjs'] } });
    const entry = write('src/exports/extensions/pi.ts', 'export class RuntimeState {}');
    const helper = write('src/services/helper.ts', 'export class Helper {}');

    expect(thinPiAdapter.check?.(entry, root, boundaryContext())).toContain('too broad');
    fs.writeFileSync(entry, 'export function activate(): void {}', 'utf8');
    expect(thinPiAdapter.check?.(entry, root, boundaryContext())).toBeNull();
    expect(thinPiAdapter.check?.(helper, root, boundaryContext())).toBeNull();
    expect(
      thinPiAdapter.check?.(path.join(root, 'src/exports/extensions/missing.ts'), root, boundaryContext()),
    ).toBeNull();
  });

  it('rejects oversized or tool-owning Pi entries', () => {
    writeManifest({ pi: { extensions: ['./dist/extensions/pi.mjs'] } });
    const oversized = write('src/exports/extensions/pi.ts', Array.from({ length: 81 }, () => '// line').join('\n'));
    expect(thinPiAdapter.check?.(oversized, root, boundaryContext())).toContain('too broad');

    const toolOwning = write('src/exports/extensions/pi.ts', 'pi.registerTool({ name: "run" });');
    expect(thinPiAdapter.check?.(toolOwning, root, boundaryContext())).toContain('too broad');
  });

  it('reserves raw Pi EventBus access for the exact Cordis host discovery adapter', () => {
    writeManifest({ name: '@agimon-ai/doompi-extension-contracts' });
    const raw = write('src/extensions/pi.ts', "pi.events.emit('ready', {});");
    const safe = write('src/services/events.ts', 'protocol.emitReady();');
    const hiddenRaw = write('src/schemas/askUser.ts', "events.on('ready', handler);");
    const aliasedRaw = write('src/services/aliased.ts', 'const bus = pi.events; bus?.on("ready", handler);');
    const destructuredRaw = write(
      'src/services/destructured.ts',
      `const { events: first } = pi; let second; second = first; second.emit('ready', payload);`,
    );
    const indexedRaw = write('src/services/indexed.ts', `pi['events'].on('ready', handler);`);
    const forwardedRaw = write(
      'src/services/forwarded.ts',
      `function bridge(bus: unknown) { bus['on']('ready', handler); } bridge(pi.events);`,
    );
    const typedRaw = write(
      'src/services/typed.ts',
      [
        `import type { EventBusLike } from '@agimon-ai/doompi-extension-contracts/protocol';`,
        `export function bridge(bus: EventBusLike) { bus.emit('ready', payload); }`,
      ].join('\n'),
    );
    const host = write(
      'src/adapters/pi/cordisHost.ts',
      [
        `export const DOOM_CORDIS_HOST_QUERY_CHANNEL = 'doom:cordis:host:v1:query';`,
        `pi.events.on(DOOM_CORDIS_HOST_QUERY_CHANNEL, handler);`,
      ].join('\n'),
    );

    expect(noRawPiEvents.check?.(raw, root, boundaryContext())).toContain('Raw Pi EventBus access');
    expect(noRawPiEvents.check?.(safe, root, boundaryContext())).toBeNull();
    expect(noRawPiEvents.check?.(hiddenRaw, root, boundaryContext())).toContain('Raw Pi EventBus access');
    expect(noRawPiEvents.check?.(aliasedRaw, root, boundaryContext())).toContain('Raw Pi EventBus access');
    expect(noRawPiEvents.check?.(destructuredRaw, root, boundaryContext())).toContain('Raw Pi EventBus access');
    expect(noRawPiEvents.check?.(indexedRaw, root, boundaryContext())).toContain('Raw Pi EventBus access');
    expect(noRawPiEvents.check?.(forwardedRaw, root, boundaryContext())).toContain('Raw Pi EventBus access');
    expect(noRawPiEvents.check?.(typedRaw, root, boundaryContext())).toContain('Raw Pi EventBus access');
    fs.writeFileSync(
      host,
      [
        `export const DOOM_CORDIS_HOST_QUERY_CHANNEL = 'doom:cordis:host:v1:query';`,
        'pi.events.on(DOOM_CORDIS_HOST_QUERY_CHANNEL, handler); pi.events.emit("doom:other", payload);',
      ].join('\n'),
      'utf8',
    );
    expect(noRawPiEvents.check?.(host, root, boundaryContext())).toContain('Raw Pi EventBus access');
    fs.writeFileSync(
      host,
      [
        `export const DOOM_CORDIS_HOST_QUERY_CHANNEL = 'doom:cordis:host:v1:query';`,
        'pi.events.on(DOOM_CORDIS_HOST_QUERY_CHANNEL, handler);',
      ].join('\n'),
      'utf8',
    );
    expect(noRawPiEvents.check?.(host, root, boundaryContext())).toBeNull();
    expect(noRawPiEvents.check?.(path.join(root, 'missing.ts'), root, boundaryContext())).toBeNull();
  });

  it('rejects same-runner protocol runtimes and legacy host/client helpers while preserving types and schemas', () => {
    writeManifest({ name: '@agimon-ai/doompi-ui' });
    const runtime = write(
      'src/adapters/pi/runtime.ts',
      [
        `import { createProtocolRuntime as createRuntime } from '@agimon-ai/doompi-extension-contracts/protocol';`,
        `import { DoomFooterStatusRegistry } from '@agimon-ai/doompi-extension-contracts/footer';`,
        `createRuntime(options);`,
        `new DoomFooterStatusRegistry();`,
      ].join('\n'),
    );
    const typeOnly = write(
      'src/types/runtime.ts',
      `import type { ProtocolRuntime } from '@agimon-ai/doompi-extension-contracts/protocol';`,
    );
    const schema = write(
      'src/schemas/leader.ts',
      `import { createDoomLeaderContribution } from '@agimon-ai/doompi-extension-contracts/leader';`,
    );
    const reexportedLegacyHelper = write(
      'src/adapters/pi/leader.ts',
      `import { registerDoomLeaderContribution } from '@agimon-ai/doompi-ui/leader';`,
    );
    const namespaceLegacyHelper = write(
      'src/adapters/pi/narration.ts',
      [
        `import * as narration from '@agimon-ai/doompi-extension-contracts/narration';`,
        `narration?.createNarrationRequester(options);`,
      ].join('\n'),
    );
    const defaultProtocolRuntime = write(
      'src/adapters/pi/defaultRuntime.ts',
      `import runtime from '@agimon-ai/doompi-extension-contracts/protocol';`,
    );
    const legacyReexport = write(
      'src/exports/legacy.ts',
      `export { registerDoomHelpContribution } from '@agimon-ai/doompi-extension-contracts/help';`,
    );
    const cordisCatalog = write(
      'src/adapters/pi/catalog.ts',
      [
        `import { createMinorModeCatalogClient } from '@agimon-ai/doompi-extension-contracts/mode-client';`,
        `import { registerMinorModeOwner } from '@agimon-ai/doompi-extension-contracts/mode-owner';`,
        `createMinorModeCatalogClient(injectedCatalog);`,
        `registerMinorModeOwner(injectedCatalog, definition);`,
      ].join('\n'),
    );
    const futureProtocolRuntime = write(
      'src/adapters/pi/futureRuntime.ts',
      `import { createFutureTransport } from '@agimon-ai/doompi-extension-contracts/protocol';`,
    );

    const result = noSameRunnerProtocol.check?.(runtime, root, boundaryContext());
    expect(result).toContain('createProtocolRuntime');
    expect(result).toContain('DoomFooterStatusRegistry');
    expect(noSameRunnerProtocol.check?.(typeOnly, root, boundaryContext())).toBeNull();
    expect(noSameRunnerProtocol.check?.(schema, root, boundaryContext())).toBeNull();
    expect(noSameRunnerProtocol.check?.(reexportedLegacyHelper, root, boundaryContext())).toContain(
      'registerDoomLeaderContribution',
    );
    expect(noSameRunnerProtocol.check?.(namespaceLegacyHelper, root, boundaryContext())).toContain(
      'createNarrationRequester',
    );
    expect(noSameRunnerProtocol.check?.(defaultProtocolRuntime, root, boundaryContext())).toContain('protocol default');
    expect(noSameRunnerProtocol.check?.(legacyReexport, root, boundaryContext())).toContain(
      'registerDoomHelpContribution',
    );
    expect(noSameRunnerProtocol.check?.(cordisCatalog, root, boundaryContext())).toBeNull();
    expect(noSameRunnerProtocol.check?.(futureProtocolRuntime, root, boundaryContext())).toContain(
      'createFutureTransport',
    );

    writeManifest({ name: '@agimon-ai/doompi-extension-contracts' });
    const legacyContractRuntime = write(
      'src/schemas/help.ts',
      [
        `import { createProtocolRuntime } from './protocol.ts';`,
        `export function provideDoomHelpHost() { return createProtocolRuntime(options); }`,
      ].join('\n'),
    );
    const pureContractSchema = write(
      'src/schemas/mcpStatus.ts',
      `export const McpStatusSchema = Type.Object({ status: Type.String() });`,
    );
    const pureCordisFacade = write(
      'src/schemas/modeClient.ts',
      `export function createMinorModeCatalogClient(catalog: MinorModeCatalogService) { return catalog.snapshot(); }`,
    );
    expect(noSameRunnerProtocol.check?.(legacyContractRuntime, root, boundaryContext())).toContain(
      'provideDoomHelpHost',
    );
    expect(noSameRunnerProtocol.check?.(legacyContractRuntime, root, boundaryContext())).toContain(
      'createProtocolRuntime',
    );
    expect(noSameRunnerProtocol.check?.(pureContractSchema, root, boundaryContext())).toBeNull();
    expect(noSameRunnerProtocol.check?.(pureCordisFacade, root, boundaryContext())).toBeNull();
  });

  it('rejects live global registries but permits exact reload handoffs, bootstrap claims, and host globals', () => {
    writeManifest({ name: '@agimon-ai/doompi-loop' });
    const registry = write(
      'src/services/launcher.ts',
      `const key = Symbol.for('doom/live');\nconst root = globalThis as Record<PropertyKey, unknown>;\nroot[key] = {};`,
    );
    const hostGlobal = write('src/services/id.ts', 'export const id = globalThis.crypto.randomUUID();');
    expect(noLiveGlobalRegistry.check?.(registry, root, boundaryContext())).toContain('process-global registry');
    expect(noLiveGlobalRegistry.check?.(hostGlobal, root, boundaryContext())).toBeNull();

    const nodeGlobal = write('src/services/nodeGlobal.ts', `const root = global; root[Symbol.for('doom/live')] = {};`);
    expect(noLiveGlobalRegistry.check?.(nodeGlobal, root, boundaryContext())).toContain('process-global registry');

    // The cockpit plugin's browser half is not process-global state: globalThis
    // in a page is the window, and in a worker the worker scope. It sat outside
    // src/ before the move to src/web and stays out of scope after it.
    const browserGlobal = write(
      'src/web/recorder.ts',
      `const key = Symbol.for('doom/live');\nconst root = globalThis as Record<PropertyKey, unknown>;\nroot[key] = new globalThis.AudioContext();`,
    );
    expect(noLiveGlobalRegistry.check?.(browserGlobal, root, boundaryContext())).toBeNull();
    writeManifest({ name: '@agimon-ai/doompi-extension-contracts' });
    const voiceReloadHandoff = write(
      'src/schemas/voiceReloadHandoff.ts',
      [
        `const VOICE_RELOAD_HANDOFF_TTL_MS = 30_000;`,
        `const key = Symbol.for('doom/voice/reload');`,
        `const state = globalThis as Record<PropertyKey, unknown>;`,
        `const record = { expiresAt: now + VOICE_RELOAD_HANDOFF_TTL_MS, hostGeneration };`,
        `if (record.expiresAt <= now) records.delete(key);`,
      ].join('\n'),
    );
    const liveVoiceRegistry = write(
      'src/schemas/voiceTools.ts',
      `const key = Symbol.for('doom/voice/live');\nconst state = globalThis as Record<PropertyKey, unknown>;`,
    );
    expect(noLiveGlobalRegistry.check?.(voiceReloadHandoff, root, boundaryContext())).toBeNull();
    expect(noLiveGlobalRegistry.check?.(liveVoiceRegistry, root, boundaryContext())).toContain(
      'process-global registry',
    );

    writeManifest({ name: '@agimon-ai/doompi-domain' });
    const reloadHandoff = write(
      'src/adapters/domainSwitchHandoff.ts',
      [
        `const DOMAIN_SWITCH_HANDOFF_TTL_MS = 30_000;`,
        `const key = Symbol.for('doom/reload');`,
        `const state = globalThis as Record<PropertyKey, unknown>;`,
        `const record = { expiresAt: now + DOMAIN_SWITCH_HANDOFF_TTL_MS, ownerGeneration };`,
        `if (record.expiresAt <= now) records.delete(key);`,
      ].join('\n'),
    );
    expect(noLiveGlobalRegistry.check?.(reloadHandoff, root, boundaryContext())).toBeNull();

    writeManifest({ name: '@agimon-ai/doompi' });
    const bootstrap = write(
      'src/adapters/bootstrapClaim.ts',
      [
        `const key = Symbol.for('doom/bootstrap');`,
        `const claim = Symbol();`,
        `Reflect.set(globalThis, key, claim);`,
        `if (Reflect.get(globalThis, key) === claim) Reflect.deleteProperty(globalThis, key);`,
      ].join('\n'),
    );
    expect(noLiveGlobalRegistry.check?.(bootstrap, root, boundaryContext())).toBeNull();

    fs.writeFileSync(bootstrap, `const key = Symbol.for('doom/bootstrap');\nReflect.set(globalThis, key, new Map());`);
    expect(noLiveGlobalRegistry.check?.(bootstrap, root, boundaryContext())).toContain('no longer proves its required');
  });

  it('centralizes Doom protocol channel literals', () => {
    const literal = write('src/services/events.ts', "export const channel = 'doom:run:start';");
    const nonSource = write('src/services/events.json', '"doom:run:start"');
    const contract = write('doompi-extension-contracts/src/protocol.ts', "export const channel = 'doom:run:start';");

    expect(noProtocolChannelLiterals.check?.(literal, root, boundaryContext())).toContain('doompi-extension-contracts');
    expect(noProtocolChannelLiterals.check?.(nonSource, root, boundaryContext())).toBeNull();
    expect(noProtocolChannelLiterals.check?.(contract, root, boundaryContext())).toBeNull();
    expect(
      noProtocolChannelLiterals.check?.(write('src/services/safe.ts', "const channel = 'app:ready';"), root),
    ).toBeNull();
  });

  it('requires external event subscriptions to be disposed on shutdown', () => {
    const unretained = write('src/extensions/pi.ts', "pi.events.on('message', handler);");
    expect(disposeExternalSubscriptions.check?.(unretained, root, boundaryContext())).toContain(
      'Retain the external subscription disposer',
    );

    const retained = write(
      'src/extensions/pi.ts',
      [
        "const disposeMessage = pi.events.on('message', handler);",
        "pi.on('session_shutdown', () => disposeMessage());",
      ].join('\n'),
    );
    expect(disposeExternalSubscriptions.check?.(retained, root, boundaryContext())).toBeNull();

    const assignedAfterDeclaration = write(
      'src/extensions/host.ts',
      [
        'let disposeQuery = (): void => undefined;',
        "disposeQuery = pi.events.on('query', handler);",
        "pi.on('session_shutdown', () => disposeQuery());",
      ].join('\n'),
    );
    expect(disposeExternalSubscriptions.check?.(assignedAfterDeclaration, root, boundaryContext())).toBeNull();
    expect(disposeExternalSubscriptions.check?.(write('src/services/safe.ts', 'run();'), root)).toBeNull();
  });

  it('rejects foreign tool-call mutation while allowing semantic policy', () => {
    const assignment = write(
      'src/extensions/assignment.ts',
      "pi.on('tool_call', (event) => { event.input = { rewritten: true }; });",
    );
    const objectMutation = write(
      'src/extensions/objectMutation.ts',
      "pi.on('tool_call', (input) => { Object.assign(input, { rewritten: true }); });",
    );
    const semanticPolicy = write(
      'src/extensions/semanticPolicy.ts',
      'registerSubagentPolicy({ allow: ["research"] });',
    );

    expect(providerOwnedPolicy.check?.(assignment, root, boundaryContext())).toContain('Do not mutate');
    expect(providerOwnedPolicy.check?.(objectMutation, root, boundaryContext())).toContain('Do not mutate');
    expect(providerOwnedPolicy.check?.(semanticPolicy, root, boundaryContext())).toBeNull();
    expect(providerOwnedPolicy.check?.(path.join(root, 'missing.ts'), root, boundaryContext())).toBeNull();
  });
});
