import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PI_SUBAGENT_PI_BINARY_ENV } from '../../src/exports/env';
import {
  findPiInstallNearEntry,
  findPiPackageRootFromEntry,
  getPiSpawnCommand,
  PI_CODING_AGENT_PACKAGE,
  resolvePiCliScript,
  resolvePiPackageRoot,
  type PiSpawnDeps,
} from '../../src/adapters/runs/shared/piSpawn';

const temporaryDirs: string[] = [];

function makeTempDir(): string {
  // Realpath'd immediately: macOS resolves os.tmpdir() through a /var -> /private/var
  // symlink, and fs.realpathSync (used by the code under test) would otherwise
  // return a path that looks different from the one this helper handed out.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-pi-spawn-')));
  temporaryDirs.push(dir);
  return dir;
}

function writeFile(dir: string, relativePath: string, content: string): string {
  const filePath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeManifest(dir: string, manifest: Record<string, unknown>): string {
  return writeFile(dir, 'package.json', JSON.stringify(manifest));
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// findPiPackageRootFromEntry
// ============================================================================

describe('findPiPackageRootFromEntry', () => {
  it('finds the package root by walking up from a nested entry point', () => {
    const dir = makeTempDir();
    writeManifest(dir, { name: PI_CODING_AGENT_PACKAGE });
    const entry = writeFile(dir, 'dist/bin/cli.mjs', '');

    expect(findPiPackageRootFromEntry(entry)).toBe(dir);
  });

  it('does not stop at a package.json belonging to a different package', () => {
    const outer = makeTempDir();
    writeManifest(outer, { name: PI_CODING_AGENT_PACKAGE });
    const inner = path.join(outer, 'node_modules', 'some-host');
    writeManifest(inner, { name: 'some-host' });
    const entry = writeFile(inner, 'dist/cli.mjs', '');

    expect(findPiPackageRootFromEntry(entry)).toBe(outer);
  });

  it('returns undefined when no ancestor manifest names the Pi package', () => {
    const dir = makeTempDir();
    writeManifest(dir, { name: 'unrelated-package' });
    const entry = writeFile(dir, 'bin/cli.mjs', '');

    expect(findPiPackageRootFromEntry(entry)).toBeUndefined();
  });

  it('never treats a Pi install beside the entry as the entry own package', () => {
    // <root>/lib/node_modules/{@earendil-works/pi-coding-agent, some-host}:
    // Pi is only the host's global-install sibling, which must not count as
    // proof that the entry IS the Pi CLI.
    const root = makeTempDir();
    const piRoot = path.join(root, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE });
    const host = path.join(root, 'lib', 'node_modules', 'some-host');
    writeManifest(host, { name: 'some-host' });
    const entry = writeFile(host, 'dist/bin/cli.mjs', '');

    expect(findPiPackageRootFromEntry(entry)).toBeUndefined();
  });

  it('skips a manifest with a non-string or missing name instead of crashing', () => {
    const dir = makeTempDir();
    writeManifest(dir, { name: 42 });
    const entry = writeFile(dir, 'bin/cli.mjs', '');

    expect(findPiPackageRootFromEntry(entry)).toBeUndefined();
  });
});

// ============================================================================
// findPiInstallNearEntry
// ============================================================================

describe('findPiInstallNearEntry', () => {
  it('finds Pi installed beside the host package, the embedding-CLI layout', () => {
    const root = makeTempDir();
    const piRoot = path.join(root, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE });
    const host = path.join(root, 'lib', 'node_modules', 'some-host');
    writeManifest(host, { name: 'some-host' });
    const entry = writeFile(host, 'dist/bin/cli.mjs', '');

    expect(findPiInstallNearEntry(entry)).toBe(piRoot);
  });

  it('finds Pi nested in the host package own node_modules', () => {
    const host = makeTempDir();
    writeManifest(host, { name: 'some-host' });
    const piRoot = path.join(host, 'node_modules', '@earendil-works', 'pi-coding-agent');
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE });
    const entry = writeFile(host, 'dist/bin/cli.mjs', '');

    expect(findPiInstallNearEntry(entry)).toBe(piRoot);
  });

  it('still finds the package root when the entry is inside Pi itself', () => {
    const dir = makeTempDir();
    writeManifest(dir, { name: PI_CODING_AGENT_PACKAGE });
    const entry = writeFile(dir, 'dist/bin/cli.mjs', '');

    expect(findPiInstallNearEntry(entry)).toBe(dir);
  });

  it('ignores a node_modules neighbor whose manifest is not the Pi package', () => {
    const host = makeTempDir();
    writeManifest(host, { name: 'some-host' });
    const impostor = path.join(host, 'node_modules', '@earendil-works', 'pi-coding-agent');
    writeManifest(impostor, { name: 'not-the-pi-package' });
    const entry = writeFile(host, 'dist/bin/cli.mjs', '');

    expect(findPiInstallNearEntry(entry)).toBeUndefined();
  });
});

// ============================================================================
// resolvePiPackageRoot
// ============================================================================

describe('resolvePiPackageRoot', () => {
  it('resolves from process.argv[1] when it is a real, provably-Pi entry point', () => {
    const dir = makeTempDir();
    writeManifest(dir, { name: PI_CODING_AGENT_PACKAGE });
    const entry = writeFile(dir, 'bin/cli.mjs', '');
    const originalArgv1 = process.argv[1];
    process.argv[1] = entry;
    try {
      expect(resolvePiPackageRoot()).toBe(dir);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it('returns undefined without throwing when argv[1] does not resolve at all, e.g. a host embedding this package', () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = path.join(makeTempDir(), 'does-not-exist.mjs');
    try {
      expect(resolvePiPackageRoot()).toBeUndefined();
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});

// ============================================================================
// resolvePiCliScript
// ============================================================================

describe('resolvePiCliScript', () => {
  it('reuses argv1 only when it is provably the Pi package entry, not just any script', () => {
    const dir = makeTempDir();
    writeManifest(dir, { name: PI_CODING_AGENT_PACKAGE });
    const entry = writeFile(dir, 'bin/cli.mjs', '');

    const deps: PiSpawnDeps = {
      argv1: entry,
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
    };
    expect(resolvePiCliScript(deps)).toBe(entry);
  });

  it('does not reuse argv1 when it belongs to a different package, e.g. the embedding host', () => {
    const dir = makeTempDir();
    writeManifest(dir, { name: 'the-embedding-host' });
    const entry = writeFile(dir, 'bin/host.mjs', '');
    const piRoot = makeTempDir();
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE, bin: { pi: 'bin/pi.mjs' } });
    const piScript = writeFile(piRoot, 'bin/pi.mjs', '');

    const deps: PiSpawnDeps = {
      argv1: entry,
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      piPackageRoot: piRoot,
    };
    expect(resolvePiCliScript(deps)).toBe(piScript);
  });

  it('ignores an argv1 that is not a runnable node script extension', () => {
    const dir = makeTempDir();
    writeManifest(dir, { name: PI_CODING_AGENT_PACKAGE });
    const entry = writeFile(dir, 'bin/cli.sh', '');
    const piRoot = makeTempDir();
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE, bin: { pi: 'bin/pi.mjs' } });
    const piScript = writeFile(piRoot, 'bin/pi.mjs', '');

    const deps: PiSpawnDeps = {
      argv1: entry,
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      piPackageRoot: piRoot,
    };
    expect(resolvePiCliScript(deps)).toBe(piScript);
  });

  it('falls back to the manifest bin field named "pi" when the argv1 route fails', () => {
    const piRoot = makeTempDir();
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE, bin: { pi: 'bin/pi.mjs', other: 'bin/other.mjs' } });
    const piScript = writeFile(piRoot, 'bin/pi.mjs', '');
    writeFile(piRoot, 'bin/other.mjs', '');

    const deps: PiSpawnDeps = {
      argv1: undefined,
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      piPackageRoot: piRoot,
    };
    expect(resolvePiCliScript(deps)).toBe(piScript);
  });

  it('accepts a string-valued bin field as well as a map', () => {
    const piRoot = makeTempDir();
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE, bin: 'bin/pi.mjs' });
    const piScript = writeFile(piRoot, 'bin/pi.mjs', '');

    const deps: PiSpawnDeps = {
      argv1: undefined,
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      piPackageRoot: piRoot,
    };
    expect(resolvePiCliScript(deps)).toBe(piScript);
  });

  it('accepts the single entry of a bin map that does not use the "pi" key, for a renamed fork', () => {
    const piRoot = makeTempDir();
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE, bin: { myfork: 'bin/myfork.mjs' } });
    const piScript = writeFile(piRoot, 'bin/myfork.mjs', '');

    const deps: PiSpawnDeps = {
      argv1: undefined,
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      piPackageRoot: piRoot,
    };
    expect(resolvePiCliScript(deps)).toBe(piScript);
  });

  it('returns undefined when the manifest has no usable bin field', () => {
    const piRoot = makeTempDir();
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE });

    const deps: PiSpawnDeps = {
      argv1: undefined,
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      piPackageRoot: piRoot,
    };
    expect(resolvePiCliScript(deps)).toBeUndefined();
  });

  it('returns undefined when the resolved bin path does not exist on disk', () => {
    const piRoot = makeTempDir();
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE, bin: { pi: 'bin/missing.mjs' } });

    const deps: PiSpawnDeps = {
      argv1: undefined,
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      piPackageRoot: piRoot,
    };
    expect(resolvePiCliScript(deps)).toBeUndefined();
  });

  it('returns undefined without throwing when package resolution itself throws', () => {
    const deps: PiSpawnDeps = {
      argv1: undefined,
      existsSync: () => false,
      resolvePackageJson: () => {
        throw new Error('cannot resolve');
      },
    };
    expect(resolvePiCliScript(deps)).toBeUndefined();
  });

  it('falls back to resolvePackageEntry when no piPackageRoot is supplied and process.argv[1] cannot resolve one', () => {
    const piRoot = makeTempDir();
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE, bin: { pi: 'bin/pi.mjs' } });
    const piScript = writeFile(piRoot, 'bin/pi.mjs', '');
    const entryUnderRoot = writeFile(piRoot, 'dist/entry.mjs', '');

    const originalArgv1 = process.argv[1];
    process.argv[1] = path.join(makeTempDir(), 'unrelated.mjs');
    try {
      const deps: PiSpawnDeps = {
        argv1: undefined,
        existsSync: (p) => fs.existsSync(p),
        realpathSync: (p) => fs.realpathSync(p),
        resolvePackageEntry: () => entryUnderRoot,
      };
      expect(resolvePiCliScript(deps)).toBe(piScript);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});

// ============================================================================
// getPiSpawnCommand
// ============================================================================

describe('getPiSpawnCommand', () => {
  it('uses the operator override binary when the env var is set, ignoring script resolution entirely', () => {
    const args = ['--session', 'x'];
    const result = getPiSpawnCommand(args, { env: { [PI_SUBAGENT_PI_BINARY_ENV]: '/opt/custom-pi' } });
    expect(result).toEqual({ command: '/opt/custom-pi', args });
  });

  it('trims whitespace around the override binary path', () => {
    const result = getPiSpawnCommand([], { env: { [PI_SUBAGENT_PI_BINARY_ENV]: '  /opt/custom-pi  ' } });
    expect(result.command).toBe('/opt/custom-pi');
  });

  it('treats an empty override as unset and falls through to script resolution', () => {
    const piRoot = makeTempDir();
    writeManifest(piRoot, { name: PI_CODING_AGENT_PACKAGE, bin: { pi: 'bin/pi.mjs' } });
    const piScript = writeFile(piRoot, 'bin/pi.mjs', '');

    const result = getPiSpawnCommand(['task'], {
      env: { [PI_SUBAGENT_PI_BINARY_ENV]: '   ' },
      argv1: undefined,
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      piPackageRoot: piRoot,
      execPath: '/usr/bin/node',
    });
    expect(result).toEqual({ command: '/usr/bin/node', args: [piScript, 'task'] });
  });

  it("runs a resolved script through this process's own node binary, so the child gets the same Node version", () => {
    const dir = makeTempDir();
    writeManifest(dir, { name: PI_CODING_AGENT_PACKAGE });
    const entry = writeFile(dir, 'bin/cli.mjs', '');

    const result = getPiSpawnCommand(['a', 'b'], {
      env: {},
      argv1: entry,
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      execPath: '/custom/node',
    });
    expect(result).toEqual({ command: '/custom/node', args: [entry, 'a', 'b'] });
  });

  it('falls back to bare "pi" on PATH when nothing can be resolved', () => {
    const result = getPiSpawnCommand(['x'], {
      env: {},
      argv1: undefined,
      existsSync: () => false,
      resolvePackageJson: () => {
        throw new Error('nope');
      },
    });
    expect(result).toEqual({ command: 'pi', args: ['x'] });
  });
});
