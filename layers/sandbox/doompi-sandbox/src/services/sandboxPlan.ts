import { DOOMPI_SANDBOX_ENV } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import type { SandboxEngine, SandboxHostFacts } from '../types/sandboxHarness.ts';
import { filterSandboxEnvironment, isCredentialEnvName } from './sandboxEnvironment.ts';
import {
  BRIDGE_CONTAINER_PATH,
  BROKER_CONTAINER_PORT,
  BROKER_PORT_ENV,
  BROKER_PROVIDERS_ENV,
  BROKER_SOCKET_CONTAINER_PATH,
  BROKER_SOCKET_ENV,
} from './sandboxBridge.ts';

const CONTAINER_HOME = '/doompi-home';
const REPOSITORY_LABEL = 'doompi.sandbox.repo';
// The harness binary, which accepts every forwarded flag; dpi hands its
// arguments straight to Pi and would reject harness options like --preset.
const LAUNCHER_BINARY = 'doompi';
const NODE_BINARY = 'node';
const LINUX_PLATFORM = 'linux';
const BROKER_MOUNT_DIRECTORY = '/run/doompi';

/** Host broker facts the plan projects into mounts and environment. */
export interface SandboxPlanBroker {
  socketDirectory: string;
  token: string;
  providers: readonly string[];
  /** Credential variables whose value the container receives as the token. */
  withheldEnv: readonly string[];
}

export interface SandboxPlanInput {
  repoRoot: string;
  cwd: string;
  forwardArgs: string[];
  environment: Readonly<Record<string, string | undefined>>;
  engine: SandboxEngine;
  host: SandboxHostFacts;
  /** Image the launch resolved, which also pins the image definition. */
  imageTag: string;
  /** Engine options the operator configured, such as an alternate runtime. */
  runFlags?: readonly string[];
  broker?: SandboxPlanBroker;
}

export interface SandboxPlan {
  imageTag: string;
  /** Full engine argv after the engine binary itself. */
  runArgs: string[];
}

/**
 * Replaces every credential in the container with the broker's session token.
 *
 * Dropping all credential-shaped variables first is what makes the promise
 * hold for providers the broker does not carry: an unbrokered key would
 * otherwise stay readable inside the container.
 */
function brokeredEnvironment(filtered: Record<string, string>, broker: SandboxPlanBroker): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(filtered)) {
    if (!isCredentialEnvName(name)) environment[name] = value;
  }
  for (const name of broker.withheldEnv) environment[name] = broker.token;
  environment[BROKER_SOCKET_ENV] = BROKER_SOCKET_CONTAINER_PATH;
  environment[BROKER_PORT_ENV] = String(BROKER_CONTAINER_PORT);
  environment[BROKER_PROVIDERS_ENV] = broker.providers.join(',');
  return environment;
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
  const { repoRoot, cwd, engine, host, broker, imageTag } = input;
  const filtered = filterSandboxEnvironment(input.environment);
  const containerEnvironment = broker ? brokeredEnvironment(filtered, broker) : filtered;
  const environmentPairs = Object.entries(containerEnvironment).sort(([left], [right]) => left.localeCompare(right));

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
    ...(broker ? ['-v', `${broker.socketDirectory}:${BROKER_MOUNT_DIRECTORY}`] : []),
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
    // Last before the image so a configured option wins over the defaults
    // above it, and cannot be mistaken for the image or its command.
    ...(input.runFlags ?? []),
    imageTag,
    // The bridge owns the loopback listener the provider SDKs dial, so it has
    // to outlive nothing but the launcher it wraps.
    ...(broker ? [NODE_BINARY, BRIDGE_CONTAINER_PATH] : []),
    LAUNCHER_BINARY,
    ...input.forwardArgs,
  ];

  return { imageTag, runArgs };
}
