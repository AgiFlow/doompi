import { DOOMPI_SANDBOX_ENV } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import type { SandboxEngine, SandboxHostFacts } from '../types/sandboxHarness.ts';
import { filterSandboxEnvironment } from './sandboxEnvironment.ts';
import { sandboxImageTag } from './sandboxImage.ts';

const CONTAINER_HOME = '/doompi-home';
const REPOSITORY_LABEL = 'doompi.sandbox.repo';
// The harness binary, which accepts every forwarded flag; dpi hands its
// arguments straight to Pi and would reject harness options like --preset.
const LAUNCHER_BINARY = 'doompi';
const LINUX_PLATFORM = 'linux';

export interface SandboxPlanInput {
  repoRoot: string;
  cwd: string;
  forwardArgs: string[];
  environment: Readonly<Record<string, string | undefined>>;
  engine: SandboxEngine;
  host: SandboxHostFacts;
}

export interface SandboxPlan {
  imageTag: string;
  /** Full engine argv after the engine binary itself. */
  runArgs: string[];
}

/**
 * Projects one launch into a disposable engine run.
 *
 * The container is ephemeral; persistence lives in two named volumes: the
 * container home (Pi sessions, sync cache) and a shadow over the repository's
 * `.pi` store, which keeps Linux installs from corrupting the host's own
 * platform-specific packages on the shared workspace mount.
 */
export function buildSandboxPlan(input: SandboxPlanInput): SandboxPlan {
  const { repoRoot, cwd, engine, host } = input;
  const imageTag = sandboxImageTag(host.version);
  const environmentPairs = Object.entries(filterSandboxEnvironment(input.environment)).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  const runArgs = [
    'run',
    '--rm',
    '-i',
    ...(host.hasTty ? ['-t'] : []),
    '--label',
    `${REPOSITORY_LABEL}=${repoRoot}`,
    '-v',
    `${repoRoot}:${repoRoot}`,
    '-v',
    `${host.repoKey}-home:${CONTAINER_HOME}`,
    '-v',
    `${host.repoKey}-pi:${repoRoot}/.pi`,
    '-w',
    cwd,
    '-e',
    `HOME=${CONTAINER_HOME}`,
    '-e',
    `${DOOMPI_SANDBOX_ENV}=1`,
    ...environmentPairs.flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    ...(host.platform === LINUX_PLATFORM && host.userId !== undefined
      ? [
          '--user',
          `${host.userId}:${host.groupId ?? host.userId}`,
          ...(engine === 'podman' ? ['--userns=keep-id'] : []),
        ]
      : []),
    imageTag,
    LAUNCHER_BINARY,
    ...input.forwardArgs,
  ];

  return { imageTag, runArgs };
}
