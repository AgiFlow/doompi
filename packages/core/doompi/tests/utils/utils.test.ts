import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRecord, readJson, writeFileAtomic, writeJson } from '../../src/exports/utils/json';
import {
  consumerPackageEntries,
  consumerPackageEntry,
  localEntries,
  optionalPackageEntries,
  optionalPackageEntry,
  ownEntry,
  packageEntries,
  packageEntry,
  piCliPath,
  splitPackageSpecifier,
} from '../../src/exports/utils/moduleResolution';
import { findRepositoryRoot, isRepositoryRoot } from '../../src/exports/utils/repository';
import { toClaudeToolName, toPiToolName } from '../../src/exports/utils/toolNames';

/** The meta-package root, whose manifest declares the local Doom closure. */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function writeExtensionPackage(packageRoot: string, name: string, extensionEntries: string[]): void {
  fs.mkdirSync(path.join(packageRoot, 'dist', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'dist', 'index.mjs'), 'export const library = true;\n');
  for (const entry of ['first.mjs', 'second.mjs', 'skip.mjs']) {
    fs.writeFileSync(path.join(packageRoot, 'dist', 'extensions', entry), 'export default () => {};\n');
  }
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      exports: { '.': './dist/index.mjs' },
      pi: { extensions: extensionEntries },
    }),
  );
}

describe('harness utilities', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-utils-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('findRepositoryRoot', () => {
    function markDoomRepository(directory: string): void {
      fs.mkdirSync(path.join(directory, '.doom'), { recursive: true });
    }

    function markPiRepository(directory: string): void {
      fs.mkdirSync(path.join(directory, '.pi'), { recursive: true });
      fs.writeFileSync(path.join(directory, '.pi', 'settings.json'), '{}');
    }

    function markGitRepository(directory: string): void {
      fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
    }

    it('walks up from a nested directory to the marked root', () => {
      markDoomRepository(root);
      const nested = path.join(root, 'packages', 'cli', 'doompi', 'src');
      fs.mkdirSync(nested, { recursive: true });

      expect(findRepositoryRoot(nested)).toBe(path.resolve(root));
    });

    it('returns the start directory when it is itself the root', () => {
      markDoomRepository(root);

      expect(findRepositoryRoot(root)).toBe(path.resolve(root));
    });

    it('accepts a consumer repository with no Nx, pnpm workspace, or plugins profile', () => {
      // A consumer installs the meta-package and configures Doom. It owes the
      // harness nothing else, so `.doom` alone has to be enough to launch.
      markDoomRepository(root);

      expect(fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'plugins', 'profiles.json'))).toBe(false);
      expect(isRepositoryRoot(root)).toBe(true);
      expect(findRepositoryRoot(root)).toBe(path.resolve(root));
    });

    it('accepts a configured Pi project as a trusted marker', () => {
      markPiRepository(root);

      expect(isRepositoryRoot(root)).toBe(true);
      expect(findRepositoryRoot(root)).toBe(path.resolve(root));
    });

    it('accepts a Git checkout before it has repository-local configuration', () => {
      markGitRepository(root);
      const nested = path.join(root, 'packages', 'consumer');
      fs.mkdirSync(nested, { recursive: true });

      expect(fs.existsSync(path.join(root, '.doom'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.pi', 'settings.json'))).toBe(false);
      expect(isRepositoryRoot(root)).toBe(true);
      expect(findRepositoryRoot(nested)).toBe(path.resolve(root));
    });

    it('accepts a Git worktree pointer file as a repository marker', () => {
      fs.writeFileSync(path.join(root, '.git'), 'gitdir: /tmp/example.git/worktrees/fixture\n');

      expect(isRepositoryRoot(root)).toBe(true);
      expect(findRepositoryRoot(root)).toBe(path.resolve(root));
    });

    it('ignores a bare .pi directory with no settings file', () => {
      // An empty `.pi` is not an approved project: trusting it would let any
      // stray directory decide which repository config gets loaded.
      fs.mkdirSync(path.join(root, '.pi'), { recursive: true });
      const nested = path.join(root, 'nested');
      fs.mkdirSync(nested);

      expect(isRepositoryRoot(root)).toBe(false);
      expect(() => findRepositoryRoot(nested)).toThrow('Could not find repository root');
    });

    it('ignores build-tooling markers on their own', () => {
      fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(root, 'plugins', 'profiles.json'), '{}');
      fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
      const nested = path.join(root, 'nested');
      fs.mkdirSync(nested);

      expect(isRepositoryRoot(root)).toBe(false);
      expect(() => findRepositoryRoot(nested)).toThrow('Could not find repository root');
    });

    it('resolves to the nearest marked ancestor', () => {
      markDoomRepository(root);
      const inner = path.join(root, 'inner');
      markDoomRepository(inner);
      const nested = path.join(inner, 'src');
      fs.mkdirSync(nested, { recursive: true });

      expect(findRepositoryRoot(nested)).toBe(path.resolve(inner));
    });

    it('ignores a .doom that is a file rather than a directory', () => {
      fs.writeFileSync(path.join(root, '.doom'), '');

      expect(isRepositoryRoot(root)).toBe(false);
    });

    it('ignores a .pi/settings.json that is a directory rather than a file', () => {
      fs.mkdirSync(path.join(root, '.pi', 'settings.json'), { recursive: true });

      expect(isRepositoryRoot(root)).toBe(false);
    });

    it('throws when no ancestor is a repository root', () => {
      expect(() => findRepositoryRoot(root)).toThrow('Could not find repository root');
    });
  });

  describe('consumer package resolution', () => {
    it('splits scoped and unscoped specifiers into a package name and subpath', () => {
      expect(splitPackageSpecifier('@scope/pkg/extensions/pi')).toEqual({
        name: '@scope/pkg',
        subpath: './extensions/pi',
      });
      expect(splitPackageSpecifier('@scope/pkg')).toEqual({ name: '@scope/pkg', subpath: '.' });
      expect(splitPackageSpecifier('pkg/index.ts')).toEqual({ name: 'pkg', subpath: './index.ts' });
      expect(splitPackageSpecifier('pkg')).toEqual({ name: 'pkg', subpath: '.' });
    });

    it('resolves a repository-declared package from the consumer root, not the meta-package', () => {
      // The consumer owns its layer packages. vibe-lint is declared by this
      // repository and is deliberately not a Doom Pi dependency, so resolving
      // it proves the lookup starts at the consumer rather than the closure.
      const entry = consumerPackageEntry('@agimon-ai/vibe-lint/extensions/pi', repoRoot);

      expect(entry).toBeDefined();
      expect(fs.existsSync(entry ?? '')).toBe(true);
      // The import condition, never the CJS build Pi cannot load as an extension.
      expect(entry?.endsWith('.mjs')).toBe(true);
    });

    it('loads a consumer-owned bare package through its declared Pi adapter', () => {
      const entries = consumerPackageEntries('@agimon-ai/vibe-lint', repoRoot);

      expect(entries).toHaveLength(1);
      expect(entries?.[0]?.replaceAll('\\', '/')).toMatch(/vibe-lint\/dist\/extensions\/pi\.mjs$/u);
    });

    it('resolves a Pi-managed Team package from the consumer root', () => {
      const packageRoot = path.join(root, '.pi', 'npm', 'node_modules', '@agimon-ai', 'doompi-team');
      writeExtensionPackage(packageRoot, '@agimon-ai/doompi-team', ['./dist/extensions/first.mjs']);

      expect(consumerPackageEntries('@agimon-ai/doompi-team', root)).toEqual([
        path.join(packageRoot, 'dist', 'extensions', 'first.mjs'),
      ]);
    });

    it('declines a package the consumer does not declare so Doom packages fall back', () => {
      expect(consumerPackageEntry('@agimon-ai/doompi-plan/extensions/doom', repoRoot)).toBeUndefined();
      expect(consumerPackageEntry('@agimonai/definitely-not-installed', repoRoot)).toBeUndefined();
    });

    it('declines when the consumer root has no manifest at all', () => {
      expect(consumerPackageEntry('@agimon-ai/vibe-lint/extensions/pi', root)).toBeUndefined();
    });

    it('expands a bare package through its standard Pi manifest while keeping explicit root resolution', () => {
      const packageName = '@fixture/manifest-extension';
      const packageRoot = path.join(root, 'node_modules', '@fixture', 'manifest-extension');
      writeExtensionPackage(packageRoot, packageName, [
        './dist/extensions/*.mjs',
        '!**/skip.mjs',
        '-dist/extensions/second.mjs',
      ]);

      expect(consumerPackageEntries(packageName, root)).toEqual([
        path.join(packageRoot, 'dist', 'extensions', 'first.mjs'),
      ]);
      expect(consumerPackageEntry(packageName, root)).toBe(path.join(packageRoot, 'dist', 'index.mjs'));
    });

    it('expands a local package manifest relative to the declaring modes file', () => {
      const packageRoot = path.join(root, 'extensions', 'local-package');
      writeExtensionPackage(packageRoot, '@fixture/local-extension', [
        './dist/extensions/first.mjs',
        './dist/extensions/second.mjs',
      ]);

      expect(localEntries('./extensions/local-package', root)).toEqual([
        path.join(packageRoot, 'dist', 'extensions', 'first.mjs'),
        path.join(packageRoot, 'dist', 'extensions', 'second.mjs'),
      ]);
    });

    it('does not fall back to a consumer package index when its Pi manifest is empty', () => {
      const packageName = '@fixture/empty-manifest-extension';
      const packageRoot = path.join(root, 'node_modules', '@fixture', 'empty-manifest-extension');
      const indexEntry = path.join(packageRoot, 'index.ts');
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(indexEntry, 'export default () => undefined;\n');
      fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: packageName, pi: { extensions: [] } }),
      );

      expect(fs.existsSync(indexEntry)).toBe(true);
      expect(consumerPackageEntries(packageName, root)).toEqual([]);
    });

    it('falls back to a local package index when no Pi manifest entry resolves', () => {
      const packageRoot = path.join(root, 'extensions', 'fallback-package');
      const indexEntry = path.join(packageRoot, 'index.js');
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(indexEntry, 'export default () => undefined;\n');
      fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@fixture/fallback-extension', pi: { extensions: ['./missing.ts'] } }),
      );

      expect(localEntries('./extensions/fallback-package', root)).toEqual([indexEntry]);
    });

    it('discovers TypeScript and JavaScript modules in a local extension directory', () => {
      const extensionRoot = path.join(root, 'extensions', 'custom');
      const nestedRoot = path.join(extensionRoot, 'nested');
      fs.mkdirSync(nestedRoot, { recursive: true });
      fs.writeFileSync(path.join(extensionRoot, 'alpha.ts'), 'export default () => undefined;\n');
      fs.writeFileSync(path.join(extensionRoot, 'beta.js'), 'export default () => undefined;\n');
      fs.writeFileSync(path.join(extensionRoot, 'ignored.md'), '# Not an extension\n');
      fs.writeFileSync(path.join(nestedRoot, 'index.mjs'), 'export default () => undefined;\n');

      expect(localEntries('./extensions/custom', root)).toEqual([
        path.join(extensionRoot, 'alpha.ts'),
        path.join(extensionRoot, 'beta.js'),
        path.join(nestedRoot, 'index.mjs'),
      ]);
      expect(localEntries('./extensions/custom/alpha.ts', root)).toEqual([path.join(extensionRoot, 'alpha.ts')]);
    });
  });

  describe('module resolution', () => {
    it('resolves an installed package to a file on disk', () => {
      expect(fs.existsSync(packageEntry('yaml'))).toBe(true);
    });

    it('returns undefined instead of throwing for a package that is absent', () => {
      expect(optionalPackageEntry('@agimonai/definitely-not-installed')).toBeUndefined();
      expect(optionalPackageEntry('yaml')).toBe(packageEntry('yaml'));
    });

    it('resolves a fixed core extension from the host package closure', () => {
      expect(optionalPackageEntry('@agimon-ai/doompi-config/extensions/pi')).toBeDefined();
    });

    it('resolves an optional layer extension to a runtime artifact', () => {
      const entry = optionalPackageEntry('@agimon-ai/vibe-lint/extensions/pi');

      expect(entry).toBeDefined();
      expect(fs.existsSync(entry ?? '')).toBe(true);
    });

    it('uses vanilla Pi discovery metadata for a bare fixed core package', () => {
      const entries = packageEntries('@agimon-ai/doompi-config');

      expect(entries).toHaveLength(1);
      expect(entries[0]?.replaceAll('\\', '/')).toMatch(/doompi-config\/dist\/extensions\/pi\.mjs$/u);
    });

    it('keeps explicit subpaths as singleton entries and tolerates missing optional packages', () => {
      expect(packageEntries('@agimon-ai/vibe-lint/extensions/pi')).toEqual([
        packageEntry('@agimon-ai/vibe-lint/extensions/pi'),
      ]);
      expect(optionalPackageEntries('@agimonai/definitely-not-installed')).toBeUndefined();
    });

    it('resolves its own entries next to this module, matching the running extension', () => {
      const entry = ownEntry('modeCatalog');

      expect(path.basename(path.dirname(entry))).toBe('entries');
      // Running from source under Node's strip-only mode, so .ts rather than .mjs.
      expect(entry.endsWith('.ts') || entry.endsWith('.mjs')).toBe(true);
      expect(fs.existsSync(entry)).toBe(true);
    });

    it('resolves the Pi CLI next to the Pi package entry', () => {
      const cli = piCliPath();

      expect(path.basename(cli)).toBe('cli.js');
      expect(fs.existsSync(cli)).toBe(true);
    });
  });

  describe('json helpers', () => {
    it('recognises plain objects only', () => {
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord([])).toBe(false);
      expect(isRecord(null)).toBe(false);
      expect(isRecord('text')).toBe(false);
    });

    it('falls back for a missing file and for an empty one', () => {
      expect(readJson(path.join(root, 'missing.json'))).toEqual({});
      expect(readJson(path.join(root, 'missing.json'), { seeded: true })).toEqual({ seeded: true });

      const empty = path.join(root, 'empty.json');
      fs.writeFileSync(empty, '   \n');
      expect(readJson(empty, { seeded: true })).toEqual({ seeded: true });
    });

    it('round-trips a written object and creates missing directories', () => {
      const target = path.join(root, 'nested', 'state.json');

      writeJson(target, { value: 1 });

      expect(readJson(target)).toEqual({ value: 1 });
      expect(fs.readFileSync(target, 'utf8').endsWith('\n')).toBe(true);
    });

    it('removes the temporary file and rethrows when the rename fails', () => {
      const target = path.join(root, 'state.json');
      vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('rename failed');
      });

      expect(() => writeFileAtomic(target, 'content')).toThrow('rename failed');
      expect(fs.readdirSync(root)).toEqual([]);
    });
  });

  describe('tool name translation', () => {
    it.each([
      ['Read', 'read'],
      ['Edit', 'edit'],
      ['Write', 'write'],
      ['Bash', 'bash'],
      ['Glob', 'find'],
      ['Grep', 'grep'],
      ['Agent', 'subagent'],
    ])('maps the Claude tool %s to the Pi tool %s and back', (claudeName, piName) => {
      expect(toPiToolName(claudeName)).toBe(piName);
      expect(toClaudeToolName(piName)).toBe(claudeName);
    });

    it('collapses web and MCP tools onto the single Pi mcp tool', () => {
      expect(toPiToolName('WebFetch')).toBe('mcp');
      expect(toPiToolName('WebSearch')).toBe('mcp');
      expect(toPiToolName('mcp__project__list')).toBe('mcp');
      expect(toPiToolName('mcp')).toBe('mcp');
    });

    it('drops Skill, which Pi discovers rather than declares', () => {
      expect(toPiToolName('Skill')).toBeUndefined();
    });

    it('passes through names already written for Pi', () => {
      expect(toPiToolName('subagent')).toBe('subagent');
      expect(toPiToolName('find')).toBe('find');
    });

    it('throws for a tool Pi has no equivalent of', () => {
      expect(() => toPiToolName('NotebookEdit')).toThrow('Unsupported agent tool: NotebookEdit');
    });

    it('leaves an unmapped Pi tool name unchanged', () => {
      expect(toClaudeToolName('mcp')).toBe('mcp');
      expect(toClaudeToolName('todo')).toBe('todo');
    });
  });
});
