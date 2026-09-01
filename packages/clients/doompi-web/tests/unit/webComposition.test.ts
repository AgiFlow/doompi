import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SyncRegistration } from '@agimon-ai/doompi/services';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWebComposition } from '../../src/adapters/webComposition.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
}

function registration(
  repositoryRoot: string,
  pluginRoots: readonly string[],
  generation: string,
  options: { web?: boolean } = {},
): SyncRegistration {
  const generationRoot = path.join(temporaryDirectory('doompi-web-composition-generation-'), generation);
  const webDirectory = path.join(generationRoot, 'web');
  const apiDirectory = path.join(generationRoot, 'api');
  const statePath = path.join(generationRoot, 'state.json');
  const resolved: Record<string, string> = {};
  for (const [index, pluginRoot] of pluginRoots.entries()) {
    const entry = path.join(pluginRoot, 'dist', 'extensions', 'pi.mjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'package.json'), '{}\n');
    fs.writeFileSync(entry, 'export {};\n');
    resolved[`plugin-${String(index)}`] = entry;
  }
  fs.mkdirSync(apiDirectory, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({ resolved })}\n`);
  fs.writeFileSync(path.join(apiDirectory, 'hub.routes.mjs'), 'export const apis = [];\n');
  if (options.web !== false) {
    fs.mkdirSync(webDirectory, { recursive: true });
    fs.writeFileSync(path.join(webDirectory, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(generationRoot, 'pluginRoots.json'), `${JSON.stringify(pluginRoots)}\n`);
  }
  return {
    version: 1,
    root: repositoryRoot,
    identity: { repositoryId: `repo-${generation}`, worktreeId: `tree-${generation}` },
    generation,
    generationRoot,
    statePath,
    stateSha256: generation.padEnd(64, '0').slice(0, 64),
    webDirectory: options.web === false ? null : webDirectory,
    apiDirectory,
    package: {
      root: repositoryRoot,
      version: '0.0.0-test',
      manifestPath: path.join(repositoryRoot, 'package.json'),
      entry: path.join(repositoryRoot, 'dist', 'index.mjs'),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('live cockpit composition resolution', () => {
  it('reuses a synchronized composition that already contains the live union', async () => {
    const firstRoot = path.join(temporaryDirectory('doompi-web-repository-'), 'first');
    const secondRoot = path.join(temporaryDirectory('doompi-web-repository-'), 'second');
    const pluginA = path.join(temporaryDirectory('doompi-web-plugin-'), 'a');
    const pluginB = path.join(temporaryDirectory('doompi-web-plugin-'), 'b');
    const first = registration(firstRoot, [pluginA], 'one');
    const second = registration(secondRoot, [pluginB, pluginA], 'two');
    const registrations = new Map([
      [firstRoot, first],
      [secondRoot, second],
    ]);
    const bundle = vi.fn();

    const resolved = await resolveWebComposition({
      repositoryRoots: [secondRoot, firstRoot],
      stateDirectory: temporaryDirectory('doompi-web-state-'),
      readRegistration: (root) => registrations.get(root),
      bundle,
    });

    expect(bundle).not.toHaveBeenCalled();
    expect(resolved).toEqual({
      repositoryRoots: [firstRoot, secondRoot].sort((left, right) => left.localeCompare(right)),
      webDirectory: second.webDirectory,
      apiDirectory: second.apiDirectory,
    });
  });

  it('builds and caches a disjoint union with both hub API registries', async () => {
    const firstRoot = path.join(temporaryDirectory('doompi-web-repository-'), 'first');
    const secondRoot = path.join(temporaryDirectory('doompi-web-repository-'), 'second');
    const pluginA = path.join(temporaryDirectory('doompi-web-plugin-'), 'a');
    const pluginB = path.join(temporaryDirectory('doompi-web-plugin-'), 'b');
    const first = registration(firstRoot, [pluginA], 'one');
    const second = registration(secondRoot, [pluginB], 'two');
    const registrations = new Map([
      [firstRoot, first],
      [secondRoot, second],
    ]);
    const stateDirectory = temporaryDirectory('doompi-web-state-');
    const bundle = vi.fn(async ({ outDir }: { outDir: string }) => {
      fs.mkdirSync(path.join(outDir, 'web'), { recursive: true });
      fs.writeFileSync(path.join(outDir, 'web', 'index.html'), '<!doctype html>');
      fs.writeFileSync(path.join(outDir, 'webPlugins.server.json'), '[]\n');
      return { assetsDir: path.join(outDir, 'web'), pluginIds: ['a', 'b'] };
    });

    const firstResolution = await resolveWebComposition({
      repositoryRoots: [firstRoot, secondRoot],
      stateDirectory,
      readRegistration: (root) => registrations.get(root),
      bundle,
    });
    const secondResolution = await resolveWebComposition({
      repositoryRoots: [secondRoot, firstRoot],
      stateDirectory,
      readRegistration: (root) => registrations.get(root),
      bundle,
    });

    expect(bundle).toHaveBeenCalledOnce();
    expect(bundle).toHaveBeenCalledWith(
      expect.objectContaining({ pluginRoots: [pluginA, pluginB].sort((left, right) => left.localeCompare(right)) }),
    );
    expect(secondResolution).toEqual(firstResolution);
    const hubRoutes = fs.readFileSync(path.join(firstResolution!.apiDirectory, 'hub.routes.mjs'), 'utf8');
    expect(hubRoutes).toContain(pathToFileURL(path.join(first.apiDirectory, 'hub.routes.mjs')).href);
    expect(hubRoutes).toContain(pathToFileURL(path.join(second.apiDirectory, 'hub.routes.mjs')).href);
  });

  it('builds from synchronized state when the repository did not publish a web bundle', async () => {
    const repositoryRoot = path.join(temporaryDirectory('doompi-web-repository-'), 'live');
    const pluginRoot = path.join(temporaryDirectory('doompi-web-plugin-'), 'voice');
    const synced = registration(repositoryRoot, [pluginRoot], 'one', { web: false });
    const bundle = vi.fn(async ({ outDir }: { outDir: string }) => {
      fs.mkdirSync(path.join(outDir, 'web'), { recursive: true });
      fs.writeFileSync(path.join(outDir, 'web', 'index.html'), '<!doctype html>');
      fs.writeFileSync(path.join(outDir, 'webPlugins.server.json'), '[]\n');
      return { assetsDir: path.join(outDir, 'web'), pluginIds: ['voice'] };
    });

    const resolved = await resolveWebComposition({
      repositoryRoots: [repositoryRoot],
      stateDirectory: temporaryDirectory('doompi-web-state-'),
      readRegistration: () => synced,
      bundle,
    });

    expect(bundle).toHaveBeenCalledWith(expect.objectContaining({ pluginRoots: [pluginRoot] }));
    expect(resolved?.webDirectory).toContain(`${path.sep}compositions${path.sep}`);
  });

  it('does not consult the launch working directory', async () => {
    const repositoryRoot = path.join(temporaryDirectory('doompi-web-repository-'), 'live');
    const pluginRoot = path.join(temporaryDirectory('doompi-web-plugin-'), 'voice');
    const synced = registration(repositoryRoot, [pluginRoot], 'one');
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('launch cwd must not be read');
    });

    await expect(
      resolveWebComposition({
        repositoryRoots: [repositoryRoot],
        stateDirectory: temporaryDirectory('doompi-web-state-'),
        readRegistration: () => synced,
      }),
    ).resolves.toMatchObject({ webDirectory: synced.webDirectory, apiDirectory: synced.apiDirectory });
  });
});
