import { DOOMPI_SANDBOX_ENV } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import type { BrokerEndpoint, SandboxEngine, SandboxHostFacts } from '../types/sandboxHarness.ts';
import { filterSandboxEnvironment, isCredentialEnvName } from './sandboxEnvironment.ts';
import { OAUTH_CALLBACK_HOST_ENV, OAUTH_CONTAINER_BIND, oauthPublishArgs } from './oauthCallback.ts';
import {
  BRIDGE_CONTAINER_PATH,
  BROKER_ADDRESS_ENV,
  BROKER_CONTAINER_PORT,
  BROKER_HOST_GATEWAY,
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
const ENABLED = '1';
const BROKER_MOUNT_DIRECTORY = '/run/doompi';

/** Host broker facts the plan projects into mounts and environment. */
export interface SandboxPlanBroker {
  endpoint: BrokerEndpoint;
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
  /** OAuth callback ports free on the host, published so a browser can reach them. */
  loginPorts?: readonly number[];
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
  if (broker.endpoint.transport === 'unix') {
    environment[BROKER_SOCKET_ENV] = BROKER_SOCKET_CONTAINER_PATH;
    // Only the bridge reads this, and only a socket needs the bridge.
    environment[BROKER_PORT_ENV] = String(BROKER_CONTAINER_PORT);
  } else {
    environment[BROKER_ADDRESS_ENV] = `${BROKER_HOST_GATEWAY}:${broker.endpoint.port}`;
  }
  environment[BROKER_PROVIDERS_ENV] = broker.providers.join(',');
  return environment;
}

/**
 * Grants the container the one route it needs to reach the broker.
 *
 * A mounted socket needs no network at all. TCP needs the engine's host
 * gateway named explicitly, because it is not resolvable by default on every
 * engine.
 */
function brokerAccessArgs(broker: SandboxPlanBroker | undefined): string[] {
  if (!broker) return [];
  if (broker.endpoint.transport === 'unix') {
    return ['-v', `${broker.endpoint.socketDirectory}:${BROKER_MOUNT_DIRECTORY}`];
  }
  return ['--add-host', `${BROKER_HOST_GATEWAY}:host-gateway`];
}

/**
 * Projects one launch into a disposable engine run.
 *
 * The container is ephemeral; persistence lives in two named volumes: the
 * container home (Pi sessions, sync cache) and a shadow over the repository's
 * `.pi` store, which keeps Linux installs from corrupting the host's own
 * platform-specific packages on the shared workspace mount.
 */
/**
 * The environment a sandboxed session runs with, whichever container hosts it.
 *
 * Shared with the dev container path, which builds no run arguments of its own
 * but must apply the same allowlist and the same credential substitution.
 */
export function containerEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  broker?: SandboxPlanBroker,
  loginPorts: readonly number[] = [],
): Record<string, string> {
  const filtered = filterSandboxEnvironment(environment);
  const resolved = broker ? brokeredEnvironment(filtered, broker) : filtered;
  resolved[DOOMPI_SANDBOX_ENV] = ENABLED;
  if (loginPorts.length > 0) resolved[OAUTH_CALLBACK_HOST_ENV] = OAUTH_CONTAINER_BIND;
  return resolved;
}

export function buildSandboxPlan(input: SandboxPlanInput): SandboxPlan {
  const { repoRoot, cwd, engine, host, broker, imageTag } = input;
  const loginPorts = input.loginPorts ?? [];
  const environmentPairs = Object.entries(containerEnvironment(input.environment, broker, loginPorts)).sort(
    ([left], [right]) => left.localeCompare(right),
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
    ...brokerAccessArgs(broker),
    ...oauthPublishArgs(loginPorts),
    '-w',
    cwd,
    '-e',
    `HOME=${CONTAINER_HOME}`,
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
    // Only a mounted socket needs the bridge: a broker on a host port is
    // addressed directly, so the launcher runs unwrapped.
    ...(broker?.endpoint.transport === 'unix' ? [NODE_BINARY, BRIDGE_CONTAINER_PATH] : []),
    LAUNCHER_BINARY,
    ...input.forwardArgs,
  ];

  return { imageTag, runArgs };
}
