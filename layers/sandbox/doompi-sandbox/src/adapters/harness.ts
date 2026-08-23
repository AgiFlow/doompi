import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { SandboxLaunchRequest } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import { buildSandboxPlan } from '../services/sandboxPlan.ts';
import { sandboxDockerfile, sandboxImageTag } from '../services/sandboxImage.ts';
import type { EngineProcessRunner, SandboxEngine, SandboxHostFacts } from '../types/sandboxHarness.ts';
import { SpawnEngineProcessRunner } from './engineProcess.ts';

const ENGINE_ENV = 'DOOMPI_SANDBOX_ENGINE';
const ENGINES: SandboxEngine[] = ['docker', 'podman'];
const DOCKERFILE_NAME = 'Dockerfile';
const MODES_FILE = path.join('.doom', 'modes.yaml');
const LOCAL_PACKAGE_PATTERN = /^\s*(?:-|name:)\s*["']?\.{1,2}\//m;
const REPO_KEY_LENGTH = 12;

// Self-reference instead of a relative path: the file depth differs between
// running from src and from the built dist tree.
const require = createRequire(import.meta.url);
const SELF_MANIFEST = '@agimon-ai/doompi-sandbox/package.json';

export interface SandboxLauncherDependencies {
  runner?: EngineProcessRunner;
  /** Distribution version override; defaults to this package's own version. */
  version?: string;
  hostFacts?: Partial<SandboxHostFacts>;
}

function distributionVersion(): string {
  return (require(SELF_MANIFEST) as { version: string }).version;
}

function repoKey(repoRoot: string): string {
  return `doompi-sandbox-${createHash('sha256').update(repoRoot).digest('hex').slice(0, REPO_KEY_LENGTH)}`;
}

async function detectEngine(
  runner: EngineProcessRunner,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SandboxEngine> {
  const configured = environment[ENGINE_ENV]?.trim();
  if (configured) {
    if ((ENGINES as string[]).includes(configured)) return configured as SandboxEngine;
    throw new Error(`${ENGINE_ENV} must be one of: ${ENGINES.join(', ')}.`);
  }
  for (const engine of ENGINES) {
    const probe = await runner.capture(engine, ['--version']);
    if (probe?.exitCode === 0) return engine;
  }
  throw new Error(`No container engine found. Install Docker or Podman, or set ${ENGINE_ENV}.`);
}

async function ensureImage(
  runner: EngineProcessRunner,
  engine: SandboxEngine,
  version: string,
  onProgress: ((message: string) => void) | undefined,
): Promise<string> {
  const tag = sandboxImageTag(version);
  const inspected = await runner.capture(engine, ['image', 'inspect', tag]);
  if (inspected?.exitCode === 0) return tag;

  onProgress?.(`building ${tag} (first run for this DoomPi version)`);
  const context = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sandbox-build-'));
  try {
    fs.writeFileSync(path.join(context, DOCKERFILE_NAME), sandboxDockerfile());
    const exitCode = await runner.run(engine, [
      'build',
      '-t',
      tag,
      '--build-arg',
      `DOOMPI_VERSION=${version}`,
      context,
    ]);
    if (exitCode !== 0) throw new Error(`Building the sandbox image failed with exit code ${exitCode}.`);
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
  return tag;
}

function warnAboutLocalPackages(repoRoot: string, onProgress: ((message: string) => void) | undefined): void {
  let modes: string;
  try {
    modes = fs.readFileSync(path.join(repoRoot, MODES_FILE), 'utf8');
  } catch {
    return;
  }
  if (LOCAL_PACKAGE_PATTERN.test(modes)) {
    onProgress?.(
      'modes.yaml declares local workspace packages; their platform-specific dependencies ' +
        'must be installed inside the container before they can load',
    );
  }
}

/** Builds the launcher with injectable seams for tests. */
export function createSandboxLauncher(dependencies: SandboxLauncherDependencies = {}) {
  const runner = dependencies.runner ?? new SpawnEngineProcessRunner();
  return {
    async launchSandbox(request: SandboxLaunchRequest): Promise<number> {
      const engine = await detectEngine(runner, request.environment);
      request.onProgress?.(`using ${engine}`);

      const version = dependencies.version ?? distributionVersion();
      const imageTag = await ensureImage(runner, engine, version, request.onProgress);
      warnAboutLocalPackages(request.repoRoot, request.onProgress);

      const host: SandboxHostFacts = {
        hasTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
        platform: process.platform,
        userId: process.getuid?.(),
        groupId: process.getgid?.(),
        repoKey: repoKey(request.repoRoot),
        version,
        ...dependencies.hostFacts,
      };
      const plan = buildSandboxPlan({
        repoRoot: request.repoRoot,
        cwd: request.cwd,
        forwardArgs: request.forwardArgs,
        environment: request.environment,
        engine,
        host,
      });
      request.onProgress?.(`starting contained session in ${imageTag}`);
      return runner.run(engine, plan.runArgs);
    },
  };
}

/** Contract entry the DoomPi harness resolves for `--sandbox`. */
export function launchSandbox(request: SandboxLaunchRequest): Promise<number> {
  return createSandboxLauncher().launchSandbox(request);
}
