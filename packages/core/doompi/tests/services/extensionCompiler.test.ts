import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extensionToolSource } from '@agimon-ai/doompi-ui/extensionName';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileExtensionSet } from '../../src/adapters/extensionCompiler.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-extension-set-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeModule(directory: string, name: string, source: string): string {
  const target = path.join(directory, `${name}.mjs`);
  fs.writeFileSync(target, source);
  return target;
}

async function loadFactory(target: string): Promise<(api: unknown) => Promise<void>> {
  const module = (await import(`${pathToFileURL(target).href}?test=${Date.now()}`)) as { default: unknown };
  return module.default as (api: unknown) => Promise<void>;
}

function readCompiledSource(entry: string): string {
  const chunkDirectory = path.join(path.dirname(entry), 'chunks');
  const chunks = fs.existsSync(chunkDirectory)
    ? fs.readdirSync(chunkDirectory).map((name) => path.join(chunkDirectory, name))
    : [];
  return [entry, ...chunks].map((target) => fs.readFileSync(target, 'utf8')).join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('compiled extension sets', () => {
  it('reuses a relocatable shared object across worktree roots', async () => {
    const directory = temporaryDirectory();
    const sharedCache = path.join(directory, 'shared-cache');
    const firstRoot = path.join(directory, 'first-worktree');
    const secondRoot = path.join(directory, 'second-worktree');
    fs.mkdirSync(path.join(firstRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(secondRoot, 'src'), { recursive: true });
    const source = 'export default (pi) => pi.registerTool({ name: "shared_cache_tool" });';
    const first = writeModule(path.join(firstRoot, 'src'), 'entry', source);
    const second = writeModule(path.join(secondRoot, 'src'), 'entry', source);

    await compileExtensionSet([first], path.join(firstRoot, 'cache'), {
      repositoryRoot: firstRoot,
      sharedCacheDirectory: sharedCache,
      outputDirectory: path.join(firstRoot, 'dist'),
      outputName: 'copilot',
    });
    fs.rmSync(firstRoot, { recursive: true, force: true });

    const output = await compileExtensionSet([second], path.join(secondRoot, 'cache'), {
      repositoryRoot: secondRoot,
      sharedCacheDirectory: sharedCache,
      outputDirectory: path.join(secondRoot, 'dist'),
      outputName: 'copilot',
    });

    const objectDirectories = fs.readdirSync(path.join(sharedCache, 'objects'));
    expect(objectDirectories).toHaveLength(1);
    const sharedSource = fs
      .readdirSync(path.join(sharedCache, 'objects', objectDirectories[0] ?? 'missing'))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) =>
        fs.readFileSync(path.join(sharedCache, 'objects', objectDirectories[0] ?? 'missing', name), 'utf8'),
      )
      .join('\n');
    expect(sharedSource).not.toContain(firstRoot);
    expect(sharedSource).not.toContain(secondRoot);
    expect(readCompiledSource(output)).toContain(secondRoot);

    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as ExtensionAPI;
    const factory = await loadFactory(output);
    await factory(pi);
    expect(extensionToolSource(pi, 'shared_cache_tool')).toBe(fs.realpathSync(second));
  });
  it('activates a production own entry', async () => {
    const directory = temporaryDirectory();
    const entry = fileURLToPath(new URL('../../src/extensions/entries/effort.ts', import.meta.url));
    const registerCommand = vi.fn();

    const output = await compileExtensionSet([entry], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory({ registerCommand });

    expect(registerCommand).toHaveBeenCalledWith('effort', expect.anything());
  });

  it('loads the full graph before preserving FIFO factory order', async () => {
    const directory = temporaryDirectory();
    const events = path.join(directory, 'events.log');
    const first = writeModule(
      directory,
      'first',
      [
        "import fs from 'node:fs';",
        `fs.appendFileSync(${JSON.stringify(events)}, 'import:first\\n');`,
        `export default () => fs.appendFileSync(${JSON.stringify(events)}, 'factory:first\\n');`,
      ].join('\n'),
    );
    const second = writeModule(
      directory,
      'second',
      [
        "import fs from 'node:fs';",
        `fs.appendFileSync(${JSON.stringify(events)}, 'import:second\\n');`,
        `export default () => fs.appendFileSync(${JSON.stringify(events)}, 'factory:second\\n');`,
      ].join('\n'),
    );

    const output = await compileExtensionSet([first, second], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory({});

    const recorded = fs.readFileSync(events, 'utf8').trim().split('\n');
    expect(recorded.slice(0, 2).sort()).toEqual(['import:first', 'import:second']);
    expect(recorded.slice(2)).toEqual(['factory:first', 'factory:second']);
  });

  it('preserves each tool original extension entry inside one bundle', async () => {
    const directory = temporaryDirectory();
    const first = writeModule(
      directory,
      'source-first',
      'export default (pi) => pi.registerTool({ name: "compiled_source_first" });',
    );
    const second = writeModule(
      directory,
      'source-second',
      'export default (pi) => pi.registerTool({ name: "compiled_source_second" });',
    );
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as ExtensionAPI;

    const output = await compileExtensionSet([first, second], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory(pi);

    expect(extensionToolSource(pi, 'compiled_source_first')).toBe(first);
    expect(extensionToolSource(pi, 'compiled_source_second')).toBe(second);
  });

  it('keeps later same-name tool definitions and provenance inside one bundle', async () => {
    const directory = temporaryDirectory();
    const first = writeModule(
      directory,
      'replacement-first',
      [
        'export default (pi) => {',
        '  pi.registerTool({ name: "read", description: "first read" });',
        '  pi.registerTool({ name: "edit", description: "first edit" });',
        '};',
      ].join('\n'),
    );
    const second = writeModule(
      directory,
      'replacement-second',
      [
        'export default (pi) => {',
        '  pi.registerTool({ name: "read", description: "second read" });',
        '  pi.registerTool({ name: "edit", description: "second edit" });',
        '};',
      ].join('\n'),
    );
    const tools = new Map<string, { name: string; description: string }>();
    const pi = {
      registerTool(tool: { name: string; description: string }) {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI;

    const output = await compileExtensionSet([first, second], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory(pi);

    expect(tools).toEqual(
      new Map([
        ['read', { name: 'read', description: 'second read' }],
        ['edit', { name: 'edit', description: 'second edit' }],
      ]),
    );
    expect(extensionToolSource(pi, 'read')).toBe(second);
    expect(extensionToolSource(pi, 'edit')).toBe(second);
  });

  it('starts later module loads while an earlier module is still evaluating', async () => {
    const directory = temporaryDirectory();
    const events = path.join(directory, 'events.log');
    const firstStarted = path.join(directory, 'first-started');
    const secondStarted = path.join(directory, 'second-started');
    const first = writeModule(
      directory,
      'first',
      [
        "import fs from 'node:fs';",
        `fs.appendFileSync(${JSON.stringify(events)}, 'import:first:start\\n');`,
        `fs.writeFileSync(${JSON.stringify(firstStarted)}, 'yes');`,
        'await new Promise((resolve, reject) => {',
        '  const deadline = Date.now() + 1000;',
        '  const poll = () => {',
        `    if (fs.existsSync(${JSON.stringify(secondStarted)})) return resolve();`,
        "    if (Date.now() >= deadline) return reject(new Error('second module did not start concurrently'));",
        '    setTimeout(poll, 1);',
        '  };',
        '  poll();',
        '});',
        `fs.appendFileSync(${JSON.stringify(events)}, 'import:first:end\\n');`,
        'export default async () => {',
        `  fs.appendFileSync(${JSON.stringify(events)}, 'factory:first:start\\n');`,
        '  await new Promise((resolve) => setTimeout(resolve, 10));',
        `  fs.appendFileSync(${JSON.stringify(events)}, 'factory:first:end\\n');`,
        '};',
      ].join('\n'),
    );
    const second = writeModule(
      directory,
      'second',
      [
        "import fs from 'node:fs';",
        'await new Promise((resolve, reject) => {',
        '  const deadline = Date.now() + 1000;',
        '  const poll = () => {',
        `    if (fs.existsSync(${JSON.stringify(firstStarted)})) return resolve();`,
        "    if (Date.now() >= deadline) return reject(new Error('first module did not start concurrently'));",
        '    setTimeout(poll, 1);',
        '  };',
        '  poll();',
        '});',
        `fs.writeFileSync(${JSON.stringify(secondStarted)}, 'yes');`,
        `fs.appendFileSync(${JSON.stringify(events)}, 'import:second\\n');`,
        `export default () => fs.appendFileSync(${JSON.stringify(events)}, 'factory:second\\n');`,
      ].join('\n'),
    );

    const output = await compileExtensionSet([first, second], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory({});

    expect(fs.readFileSync(events, 'utf8').trim().split('\n')).toEqual([
      'import:first:start',
      'import:second',
      'import:first:end',
      'factory:first:start',
      'factory:first:end',
      'factory:second',
    ]);
  });

  it('preserves a lazy import whose async module graph contains a cycle', async () => {
    const directory = temporaryDirectory();
    writeModule(directory, 'shared', 'await Promise.resolve(); export const shared = "ready";');
    writeModule(
      directory,
      'first',
      [
        'import { shared } from "./shared.mjs";',
        'import { second } from "./second.mjs";',
        'export function first() { return shared + second(); }',
      ].join('\n'),
    );
    writeModule(
      directory,
      'second',
      [
        'import { shared } from "./shared.mjs";',
        'import { first } from "./first.mjs";',
        'export function second() { void first; return shared; }',
      ].join('\n'),
    );
    writeModule(
      directory,
      'lazy-session',
      ['import { first } from "./first.mjs";', 'export function open(api) { api.render(); return first(); }'].join(
        '\n',
      ),
    );
    const entry = writeModule(
      directory,
      'entry',
      [
        'export default (api) => {',
        '  api.execute = async () => (await import("./lazy-session.mjs")).open(api);',
        '};',
      ].join('\n'),
    );
    const render = vi.fn();
    const api: { render: () => void; execute?: () => Promise<string> } = { render };

    const output = await compileExtensionSet([entry], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory(api);
    if (!api.execute) throw new Error('Compiled extension did not register its execute callback');

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Lazy module did not finish evaluating')), 1000);
      });
      await expect(Promise.race([api.execute(), timeout])).resolves.toBe('readyready');
    } finally {
      if (timer) clearTimeout(timer);
    }
    expect(render).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.join(path.dirname(output), 'chunks'))).not.toHaveLength(0);
  });

  it('uses a fresh graph manifest and invalidates when a dependency changes', async () => {
    const directory = temporaryDirectory();
    const dependency = writeModule(directory, 'value', 'export default "one";');
    const entry = writeModule(
      directory,
      'entry',
      'import value from "./value.mjs"; export default (api) => api.push(value);',
    );
    const cache = path.join(directory, 'cache');

    const first = await compileExtensionSet([entry], cache);
    expect(await compileExtensionSet([entry], cache)).toBe(first);

    fs.writeFileSync(dependency, 'export default "two changed";');
    const second = await compileExtensionSet([entry], cache);
    expect(second).not.toBe(first);

    const values: string[] = [];
    const factory = await loadFactory(second);
    await factory(values);
    expect(values).toEqual(['two changed']);
  });

  it('restores a missing split artifact before reusing a graph manifest', async () => {
    const directory = temporaryDirectory();
    const lazy = writeModule(directory, 'lazy', 'export const value = "loaded";');
    const entry = writeModule(
      directory,
      'entry',
      `export default async (api) => api.push((await import(${JSON.stringify(lazy)})).value);`,
    );
    const cache = path.join(directory, 'cache');
    const output = await compileExtensionSet([entry], cache);
    const chunkDirectory = path.join(path.dirname(output), 'chunks');
    const removed = path.join(chunkDirectory, fs.readdirSync(chunkDirectory)[0] ?? 'missing');
    fs.rmSync(removed);

    expect(await compileExtensionSet([entry], cache)).toBe(output);
    expect(fs.existsSync(removed)).toBe(true);
  });

  it('repairs an existing same-name artifact after graph invalidation', async () => {
    const directory = temporaryDirectory();
    const dependency = writeModule(directory, 'value', 'export default "current";');
    const entry = writeModule(
      directory,
      'entry',
      'import value from "./value.mjs"; export default (api) => api.push(value);',
    );
    const cache = path.join(directory, 'cache');
    const output = await compileExtensionSet([entry], cache);
    fs.writeFileSync(output, 'export default () => { throw new Error("stale artifact"); };');
    const invalidatedAt = new Date(Date.now() + 10_000);
    fs.utimesSync(dependency, invalidatedAt, invalidatedAt);

    const repaired = await compileExtensionSet([entry], cache);
    const values: string[] = [];
    const factory = await loadFactory(repaired);
    await factory(values);

    expect(repaired).toBe(output);
    expect(values).toEqual(['current']);
    expect(fs.readFileSync(repaired, 'utf8')).not.toContain('stale artifact');
  });

  it('requires the same default factory contract as the host loader', async () => {
    const directory = temporaryDirectory();
    const namedOnly = writeModule(
      directory,
      'named-only',
      'export const notifications = (api) => api.push("named-only");',
    );
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const values: string[] = [];

    const output = await compileExtensionSet([namedOnly], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory(values);

    expect(values).toEqual([]);
    expect(write.mock.calls.flat().join('')).toContain('does not export an extension factory');
  });

  it('keeps activating later factories after one factory fails', async () => {
    const directory = temporaryDirectory();
    const broken = writeModule(directory, 'broken', 'export default () => { throw new Error("boom"); };');
    const healthy = writeModule(directory, 'healthy', 'export default (api) => api.push("healthy");');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const values: string[] = [];

    const output = await compileExtensionSet([broken, healthy], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory(values);

    expect(values).toEqual(['healthy']);
    expect(write.mock.calls.flat().join('')).toContain('boom');
  });

  it('preserves each bundled module URL for package-owned resource lookup', async () => {
    const directory = temporaryDirectory();
    const packageDirectory = path.join(directory, 'workflow-package');
    const extensionDirectory = path.join(packageDirectory, 'dist', 'extensions');
    const workflowDirectory = path.join(packageDirectory, 'dist', 'workflow');
    const skillPath = path.join(packageDirectory, 'skills', 'workflow-recovery', 'SKILL.md');
    fs.mkdirSync(extensionDirectory, { recursive: true });
    fs.mkdirSync(workflowDirectory, { recursive: true });
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '# Recovery skill\n');
    const implementation = writeModule(
      workflowDirectory,
      'piExtension',
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        'const ownedSkill = path.resolve(path.dirname(fileURLToPath(import.meta.url)),',
        "  '../../skills/workflow-recovery/SKILL.md');",
        'export default (api) => api.push({',
        '  moduleUrl: import.meta.url,',
        "  skill: fs.readFileSync(ownedSkill, 'utf8'),",
        '});',
      ].join('\n'),
    );
    const entry = writeModule(extensionDirectory, 'pi', "export { default } from '../workflow/piExtension.mjs';");
    const values: Array<{ moduleUrl: string; skill: string }> = [];

    const output = await compileExtensionSet([entry], path.join(directory, 'cache'), {
      outputDirectory: path.join(directory, '.pi', 'doom', 'dist'),
    });
    const factory = await loadFactory(output);
    await factory(values);

    expect(values).toEqual([
      {
        moduleUrl: pathToFileURL(fs.realpathSync(implementation)).href,
        skill: '# Recovery skill\n',
      },
    ]);
  });

  it('verifies a shared build containing the legacy TypeBox alias provided by Pi', async () => {
    const directory = temporaryDirectory();
    const entry = writeModule(
      directory,
      'legacy-typebox',
      ["import { Type } from '@sinclair/typebox';", 'export default (api) => api.push(Type.String().type);'].join('\n'),
    );
    const values: string[] = [];

    const output = await compileExtensionSet([entry], path.join(directory, 'cache'), {
      repositoryRoot: directory,
      sharedCacheDirectory: path.join(directory, 'shared-cache'),
    });
    const factory = await loadFactory(output);
    await factory(values);

    const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const piTypeboxEntry = createRequire(piEntry).resolve('typebox');
    expect(values).toEqual(['string']);
    expect(readCompiledSource(output)).not.toMatch(/from\s*["']@sinclair\/typebox/u);
    expect(readCompiledSource(output)).toContain(piTypeboxEntry);
  });

  it('keeps dependency-heavy ESM packages external to reduce aggregate linking work', async () => {
    const directory = temporaryDirectory();
    const yamlEntry = createRequire(import.meta.url).resolve('yaml');
    const entry = writeModule(
      directory,
      'external-runtime',
      [
        `import { parse } from ${JSON.stringify(yamlEntry)};`,
        'export default (api) => api.push(parse("ready: true").ready);',
      ].join('\n'),
    );
    const values: boolean[] = [];

    const output = await compileExtensionSet([entry], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory(values);

    expect(values).toEqual([true]);
    expect(readCompiledSource(output)).toContain(yamlEntry);
  });

  it('keeps TypeScript external as its package surface moves to native ESM subpaths', async () => {
    const directory = temporaryDirectory();
    const typescriptEntry = createRequire(import.meta.url).resolve('typescript');
    const entry = writeModule(
      directory,
      'typescript-runtime',
      [`import ts from ${JSON.stringify(typescriptEntry)};`, 'export default (api) => api.push(ts.version);'].join(
        '\n',
      ),
    );
    const values: string[] = [];

    const output = await compileExtensionSet([entry], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory(values);

    expect(values).toHaveLength(1);
    expect(typeof values[0]).toBe('string');
    expect(readCompiledSource(output)).toContain(typescriptEntry);
  });

  it('keeps open external so its import.meta.url helper lookup retains the installed location', async () => {
    const directory = temporaryDirectory();
    const openEntry = path.join(directory, 'node_modules', 'open', 'index.js');
    fs.mkdirSync(path.dirname(openEntry), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(openEntry), 'package.json'),
      JSON.stringify({ name: 'open', type: 'module' }),
    );
    fs.writeFileSync(
      openEntry,
      [
        'import { fileURLToPath } from "node:url";',
        'export default () => fileURLToPath(new URL("./xdg-open", import.meta.url));',
      ].join('\n'),
    );
    const entry = writeModule(
      directory,
      'commonjs-runtime',
      [
        `import openDirectory from ${JSON.stringify(openEntry)};`,
        'export default (api) => api.push(openDirectory());',
      ].join('\n'),
    );
    const values: string[] = [];

    const output = await compileExtensionSet([entry], path.join(directory, 'cache'));
    const factory = await loadFactory(output);
    await factory(values);

    expect(values).toEqual([path.join(path.dirname(fs.realpathSync(openEntry)), 'xdg-open')]);
    expect(readCompiledSource(output)).toContain(openEntry);
  });

  it('rejects unresolved imports instead of emitting broken dist externals', async () => {
    const directory = temporaryDirectory();
    const entry = writeModule(directory, 'broken-import', "import 'missing-doompi-package'; export default () => {};");

    await expect(compileExtensionSet([entry], path.join(directory, 'cache'))).rejects.toThrow(
      /missing-doompi-package/u,
    );
  });

  it('writes a named artifact to dist while keeping graph manifests in cache', async () => {
    const directory = temporaryDirectory();
    const entry = writeModule(directory, 'entry', 'export default () => undefined;');
    const cache = path.join(directory, 'cache');
    const dist = path.join(directory, 'dist');

    const output = await compileExtensionSet([entry], cache, {
      outputDirectory: dist,
      outputName: 'copilot / unsafe',
    });

    expect(output).toMatch(/\/dist\/copilot-unsafe\.[a-f0-9]+\.mjs$/);
    expect(fs.readdirSync(path.join(cache, 'sets'))).toContainEqual(expect.stringMatching(/\.json$/));
    expect(fs.readdirSync(dist).sort()).toEqual(['chunks', path.basename(output)].sort());
    expect(fs.readdirSync(path.join(dist, 'chunks'))).not.toHaveLength(0);
  });
});
