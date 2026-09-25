import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DOOM_MCP_BUNDLE_FILE } from '@agimon-ai/doompi-core/mcpFacet';
import { afterEach, describe, expect, it } from 'vitest';

import type { ExtensionComposition } from '../../src/builders/cli/extensionAssembler';
import { syncMcpBundle, type McpBundleSyncInput } from '../../src/builders/server/mcpBundle';
import { mcpBundleIsFresh, mcpBundleIsRuntimeUsable } from '../../src/composition/syncDrift';
import { computeMcpSourcesHash } from '../../src/composition/syncState';

const roots: string[] = [];

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function composition(entry: string): ExtensionComposition {
  return {
    version: 4,
    majorMode: { name: 'coding' },
    layers: [],
    selections: [
      {
        layer: 'tools',
        layerIndex: 0,
        entryKind: 'package',
        entryIndex: 0,
        manifestIndex: 0,
        selector: entry,
        baseDirectory: path.dirname(entry),
        optional: false,
        outcome: 'resolved',
        path: entry,
      },
    ],
    parentActivation: [entry],
    childActivation: [],
    fingerprint: 'b'.repeat(64),
  };
}

function fixture(): {
  input: McpBundleSyncInput;
  entry: string;
  source: string;
  dependency: string;
  resolved: Record<string, string>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-bundle-'));
  roots.push(root);
  const packageRoot = path.join(root, 'plugin');
  const entry = path.join(packageRoot, 'dist', 'pi.mjs');
  const source = path.join(packageRoot, 'src', 'plugin.mcp.ts');
  const dependency = path.join(packageRoot, 'dist', 'dependency.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(entry, 'export default () => undefined;');
  fs.writeFileSync(source, 'export const source = "before";');
  fs.writeFileSync(dependency, 'export const value = "before";');
  fs.writeFileSync(
    path.join(packageRoot, 'dist', 'mcp.mjs'),
    'import { value } from "./dependency.mjs"; export default { name: value, session: { tools: [], skills: [] } };',
  );
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@test/plugin',
      doompiMcp: { entry: './src/plugin.mcp.ts', dist: './dist/mcp.mjs', scopes: ['session'] },
    }),
  );
  const input: McpBundleSyncInput = {
    repositoryRoot: root,
    generation: 'generation',
    fingerprint: 'a'.repeat(64),
    compositions: [composition(entry)],
    outputDirectory: path.join(root, 'generation', 'mcp'),
    cacheDirectory: path.join(root, 'generation', 'cache'),
  };
  return { input, entry, source, dependency, resolved: { plugin: entry } };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('MCP bundle sync integrity', () => {
  it('records artifact hashes and detects source, compiler input, and generated artifact drift', async () => {
    const { input, source, dependency, resolved } = fixture();
    const result = await syncMcpBundle(input);
    const descriptorPath = path.join(input.outputDirectory, DOOM_MCP_BUNDLE_FILE);
    const modulePath = path.resolve(input.outputDirectory, result.descriptor.entries[0]!.module);
    const state = {
      resolved,
      mcpBundle: {
        descriptorPath,
        fingerprint: input.fingerprint,
        compilerManifests: result.compilerManifests,
        sourcesHash: computeMcpSourcesHash(resolved),
      },
    };
    const registration = {
      generation: input.generation,
      generationRoot: path.dirname(input.outputDirectory),
      mcpBundle: { path: descriptorPath, fingerprint: input.fingerprint, sha256: sha256(descriptorPath) },
    };

    expect(result.descriptor.entries[0]?.sha256).toBe(sha256(modulePath));
    expect(mcpBundleIsFresh(state, registration)).toBe(true);

    const descriptorBytes = fs.readFileSync(descriptorPath);
    fs.appendFileSync(descriptorPath, '\n');
    expect(mcpBundleIsRuntimeUsable(state, registration)).toBe(false);
    fs.writeFileSync(descriptorPath, descriptorBytes);

    fs.writeFileSync(source, 'export const source = "changed";');
    expect(mcpBundleIsFresh(state, registration)).toBe(false);
    expect(mcpBundleIsRuntimeUsable(state, registration)).toBe(true);

    fs.writeFileSync(source, 'export const source = "before";');
    fs.writeFileSync(dependency, 'export const value = "changed";');
    expect(mcpBundleIsFresh(state, registration)).toBe(false);
    expect(mcpBundleIsRuntimeUsable(state, registration)).toBe(true);

    fs.appendFileSync(modulePath, '\n// tampered');
    expect(mcpBundleIsRuntimeUsable(state, registration)).toBe(false);
  });
});

it('composes package widgets once and fingerprints both their source graph and the immutable HTML', async () => {
  const { input, entry, resolved } = fixture();
  const root = path.dirname(path.dirname(entry));
  const packageFile = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  manifest.doompiMcp.ui = { entry: './src/read.mcp.tsx', dist: './dist/mcp-ui.mjs', widgets: ['@test/plugin/read'] };
  fs.writeFileSync(packageFile, JSON.stringify(manifest));
  const browserEntry = path.join(root, 'dist', 'mcp-ui.mjs');
  fs.writeFileSync(browserEntry, 'export const widgets = { "@test/plugin/read": function Read() { return null; } };');
  const result = await syncMcpBundle(input);
  expect(result.descriptor.ui).toBeDefined();
  expect(result.descriptor.entries[0]?.widgets).toEqual(['@test/plugin/read']);
  const uiFile = path.resolve(input.outputDirectory, result.descriptor.ui!.file);
  expect(result.descriptor.ui!.sha256).toBe(sha256(uiFile));
  expect(
    result.descriptor.ui!.inputs.some((file) =>
      file.path.startsWith(fs.realpathSync(input.outputDirectory) + path.sep),
    ),
  ).toBe(false);
  expect(result.descriptor.ui!.inputs.some((file) => file.path === fs.realpathSync(browserEntry))).toBe(true);
  expect(fs.readFileSync(uiFile, 'utf8')).toContain('<!doctype html>');
  expect(fs.readFileSync(uiFile, 'utf8')).not.toMatch(/<script[^>]+src=/u);
  const descriptorPath = path.join(input.outputDirectory, DOOM_MCP_BUNDLE_FILE);
  const state = {
    resolved,
    mcpBundle: {
      descriptorPath,
      fingerprint: input.fingerprint,
      compilerManifests: result.compilerManifests,
      sourcesHash: computeMcpSourcesHash(resolved),
    },
  };
  const registration = {
    generation: input.generation,
    generationRoot: path.dirname(input.outputDirectory),
    mcpBundle: { path: descriptorPath, fingerprint: input.fingerprint, sha256: sha256(descriptorPath) },
  };
  expect(mcpBundleIsFresh(state, registration)).toBe(true);
  fs.appendFileSync(browserEntry, '\n// source changed');
  expect(mcpBundleIsFresh(state, registration)).toBe(false);
  expect(mcpBundleIsRuntimeUsable(state, registration)).toBe(true);
  fs.appendFileSync(uiFile, '\nchanged');
  expect(mcpBundleIsRuntimeUsable(state, registration)).toBe(false);
}, 30_000);
