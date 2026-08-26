import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Reproduces the managed-install layout (`<project>/.pi/npm/node_modules`)
 * that `realPi.system.test.ts` cannot see: there the workspace package is
 * SYMLINKED into the fixture, node resolves through the symlink's realpath,
 * and the child runner finds the workspace's own Pi SDK. Here the built
 * package is COPIED, its runtime dependencies are linked in, and the Pi peers
 * are deliberately absent, exactly like a `.pi/npm` install. A detached SDK
 * child died at module-link time under that layout until the `--import`
 * alias preamble existed; both halves are pinned below.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A dependency's on-disk root through this package's own node_modules links,
 * realpath'd out of the pnpm store. Resolver-based lookups are no use here:
 * closed exports maps (Pi's among them) expose neither `<name>/package.json`
 * nor a require entry.
 */
function packageRootOf(name: string): string {
  const root = fs.realpathSync(path.join(packageRoot, 'node_modules', name));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string };
  if (manifest.name !== name) throw new Error(`'${root}' does not hold '${name}'.`);
  return root;
}
const SDK_RUNNER_RELATIVE = path.join('dist', 'runs', 'sdkRunnerEntry.mjs');
const ALIAS_RELATIVE = path.join('dist', 'runs', 'piModuleAlias.mjs');
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const SPAWN_TIMEOUT_MS = 20_000;

let installRoot: string;
let installedPackage: string;
let piRoot: string;

function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // A managed install's child gets a full user environment; what matters here
  // is that no harness or Pi variable from THIS test process leaks in.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function runNode(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, args, {
    cwd: installRoot,
    env,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  return { status: result.status, stderr: result.stderr };
}

beforeAll(() => {
  for (const artifact of [SDK_RUNNER_RELATIVE, ALIAS_RELATIVE]) {
    if (!fs.existsSync(path.join(packageRoot, artifact))) {
      throw new Error(`Build the package first: '${artifact}' is missing. Run pnpm build.`);
    }
  }
  piRoot = packageRootOf(PI_PACKAGE);

  installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-packaged-'));
  installedPackage = path.join(installRoot, 'node_modules', '@agimon-ai', 'doompi-team');
  fs.mkdirSync(installedPackage, { recursive: true });
  fs.cpSync(path.join(packageRoot, 'dist'), path.join(installedPackage, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(installedPackage, 'package.json'));

  // Runtime dependencies are present in a managed install; the Pi peers are
  // not, which is the whole point of this fixture.
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const target = packageRootOf(dependency);
    const linkPath = path.join(installRoot, 'node_modules', dependency);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, 'dir');
  }
});

afterAll(() => {
  fs.rmSync(installRoot, { recursive: true, force: true });
});

describe('the SDK runner under a managed-install layout', () => {
  it('dies at link time without the alias preamble, the bug this fixture pins', () => {
    const { status, stderr } = runNode([path.join(installedPackage, SDK_RUNNER_RELATIVE)], childEnvironment());

    expect(status).not.toBe(0);
    expect(stderr).toContain('ERR_MODULE_NOT_FOUND');
    expect(stderr).toContain(PI_PACKAGE);
  });

  it('links against the host Pi package through the alias preamble', () => {
    const { status, stderr } = runNode(
      ['--import', path.join(installedPackage, ALIAS_RELATIVE), path.join(installedPackage, SDK_RUNNER_RELATIVE)],
      childEnvironment({ PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: piRoot }),
    );

    // Reaching the runner's own argument validation proves every module in
    // the child graph linked; the run id is deliberately absent.
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(stderr).toContain('PI_SUBAGENT_RUN_ID is required');
    expect(status).not.toBe(0);
  });

  it('changes nothing when no package root is handed over', () => {
    const { status, stderr } = runNode(
      ['--import', path.join(installedPackage, ALIAS_RELATIVE), path.join(installedPackage, SDK_RUNNER_RELATIVE)],
      childEnvironment(),
    );

    expect(status).not.toBe(0);
    expect(stderr).toContain('ERR_MODULE_NOT_FOUND');
  });
});
