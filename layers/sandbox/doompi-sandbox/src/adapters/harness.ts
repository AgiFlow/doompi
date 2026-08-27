import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { SandboxLaunchRequest } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import { findDevcontainerConfig, runDevcontainerSession } from './devcontainer.ts';
import { DEVCONTAINER_DISABLED_ENV } from '../services/devcontainer.ts';
import { availableLoginPorts } from './loginPorts.ts';
import { startBroker, type RunningBroker } from './brokerHost.ts';
import { BRIDGE_FILE_NAME, sandboxBridgeSource } from '../services/sandboxBridge.ts';
import { buildSandboxPlan, containerEnvironment } from '../services/sandboxPlan.ts';
import { OAUTH_CALLBACK_PORTS } from '../services/oauthCallback.ts';
import { assertRunFlags, parseRunFlags } from '../services/runFlags.ts';
import { sandboxDockerfile } from '../services/sandboxImage.ts';
import { sandboxImageTag } from './sandboxImageTag.ts';
import type { EngineProcessRunner, SandboxEngine, SandboxHostFacts } from '../types/sandboxHarness.ts';
import { SpawnEngineProcessRunner } from './engineProcess.ts';

const ENGINE_ENV = 'DOOMPI_SANDBOX_ENGINE';
const BROKER_DISABLED_ENV = 'DOOMPI_SANDBOX_BROKER';
const RUN_FLAGS_ENV = 'DOOMPI_SANDBOX_RUN_FLAGS';
const DISABLED_VALUE = '0';
// Every entry takes docker's run syntax, which is what the plan emits.
const ENGINES: SandboxEngine[] = ['docker', 'podman', 'nerdctl', 'finch'];
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
  /** Seam for tests; defaults to probing the real OAuth callback ports. */
  loginPorts?: () => Promise<number[]>;
  /** Seam for tests; defaults to the real host broker. */
  startBroker?: (options: {
    environment: Readonly<Record<string, string | undefined>>;
    onDenied?: (reason: string) => void;
  }) => Promise<RunningBroker | undefined>;
  /** Distribution version override; defaults to this package's own version. */
  version?: string;
  hostFacts?: Partial<SandboxHostFacts>;
}

function distributionVersion(): string {
  return (require(SELF_MANIFEST) as { version: string }).version;
}

/** Fixed per-repository directory a reused dev container can keep mounted. */
function brokerDirectory(repoRoot: string): string {
  return path.join(os.tmpdir(), `${repoKey(repoRoot)}-broker`);
}

function repoKey(repoRoot: string): string {
  return `doompi-sandbox-${createHash('sha256').update(repoRoot).digest('hex').slice(0, REPO_KEY_LENGTH)}`;
}

export async function detectEngine(
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
  throw new Error(`No container engine found. Install one of ${ENGINES.join(', ')}, or set ${ENGINE_ENV}.`);
}

/**
 * Builds the image if the engine does not already have it.
 *
 * Takes its definition rather than assuming one, because the interactive
 * sandbox and the cockpit container are two different images built the same
 * way. The tag already carries a digest of the definition, so a changed
 * Dockerfile misses the inspect and rebuilds.
 */
export async function ensureImage(
  runner: EngineProcessRunner,
  engine: SandboxEngine,
  version: string,
  onProgress: ((message: string) => void) | undefined,
  definition: { tag: string; dockerfile: string; files?: Readonly<Record<string, string>> },
): Promise<string> {
  const tag = definition.tag;
  const inspected = await runner.capture(engine, ['image', 'inspect', tag]);
  if (inspected?.exitCode === 0) return tag;

  onProgress?.(`building ${tag} (first run for this DoomPi version)`);
  const context = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sandbox-build-'));
  try {
    fs.writeFileSync(path.join(context, DOCKERFILE_NAME), definition.dockerfile);
    for (const [name, contents] of Object.entries(definition.files ?? {})) {
      fs.writeFileSync(path.join(context, name), contents);
    }
    const exitCode = await runner.run(engine, [
      'build',
      '-t',
      tag,
      '--build-arg',
      `DOOMPI_VERSION=${version}`,
      context,
    ]);
    if (exitCode !== 0) throw new Error(`Building the ${tag} image failed with exit code ${exitCode}.`);
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
  const beginBroker = dependencies.startBroker ?? startBroker;
  const resolveLoginPorts = dependencies.loginPorts ?? availableLoginPorts;
  return {
    async launchSandbox(request: SandboxLaunchRequest): Promise<number> {
      const engine = await detectEngine(runner, request.environment);
      const runFlags = parseRunFlags(request.environment[RUN_FLAGS_ENV]);
      assertRunFlags(runFlags, RUN_FLAGS_ENV);
      request.onProgress?.(`using ${engine}${runFlags.length > 0 ? ` with ${runFlags.join(' ')}` : ''}`);

      const version = dependencies.version ?? distributionVersion();
      // A workspace that describes its own container is describing the
      // toolchain its agent needs, so that container wins over the built-in
      // image. Nothing here is built or pulled until that choice is made.
      const devcontainer =
        request.environment[DEVCONTAINER_DISABLED_ENV] === DISABLED_VALUE
          ? undefined
          : findDevcontainerConfig(request.repoRoot);
      const imageTag = devcontainer
        ? undefined
        : await ensureImage(runner, engine, version, request.onProgress, {
            tag: sandboxImageTag(version),
            dockerfile: sandboxDockerfile(),
            files: { [BRIDGE_FILE_NAME]: sandboxBridgeSource() },
          });
      if (devcontainer) {
        request.onProgress?.(`using the workspace dev container from ${path.relative(request.repoRoot, devcontainer)}`);
        request.onProgress?.(
          'its configuration owns the mounts and run arguments, so this is not an isolation boundary',
        );
      } else {
        warnAboutLocalPackages(request.repoRoot, request.onProgress);
      }

      const broker =
        request.environment[BROKER_DISABLED_ENV] === DISABLED_VALUE
          ? undefined
          : await beginBroker({
              environment: request.environment,
              onDenied: (reason) => request.onProgress?.(`broker refused a call: ${reason}`),
              // A reused dev container keeps the mounts it was created with,
              // so the socket has to be at the same path on every launch.
              ...(devcontainer ? { socketDirectory: brokerDirectory(request.repoRoot) } : {}),
            });
      if (broker) {
        request.onProgress?.(`brokering ${broker.providers.join(', ')}; provider keys stay on the host`);
      }

      const loginPorts = devcontainer ? [] : await resolveLoginPorts();
      if (!devcontainer && loginPorts.length < OAUTH_CALLBACK_PORTS.length) {
        request.onProgress?.(
          'some OAuth callback ports are already taken; /login inside this sandbox may not complete',
        );
      }

      try {
        const hasTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
        if (devcontainer) {
          return await runDevcontainerSession({
            repoRoot: request.repoRoot,
            cwd: request.cwd,
            forwardArgs: request.forwardArgs,
            environment: containerEnvironment(request.environment, broker),
            engine,
            runner,
            version,
            hasTty,
            ...(broker?.endpoint.transport === 'unix' ? { socketDirectory: broker.endpoint.socketDirectory } : {}),
            ...(request.onProgress ? { onProgress: request.onProgress } : {}),
          });
        }

        const host: SandboxHostFacts = {
          hasTty,
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
          imageTag: imageTag as string,
          runFlags,
          loginPorts,
          broker,
        });
        request.onProgress?.(`starting contained session in ${imageTag}`);
        return await runner.run(engine, plan.runArgs);
      } finally {
        await broker?.stop();
      }
    },
  };
}

/** Contract entry the DoomPi harness resolves for `--sandbox`. */
export function launchSandbox(request: SandboxLaunchRequest): Promise<number> {
  return createSandboxLauncher().launchSandbox(request);
}
