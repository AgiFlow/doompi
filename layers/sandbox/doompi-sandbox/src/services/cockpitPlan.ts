import { DOOMPI_SANDBOX_ENV } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import type { CockpitWorkspace } from '@agimon-ai/doompi-extension-contracts/cockpit-container';
import type { SandboxEngine, SandboxHostFacts } from '../types/sandboxHarness.ts';
import { DEVCONTAINER_DISABLED_ENV } from './devcontainer.ts';
import { containerEnvironment, type SandboxPlanBroker } from './sandboxPlan.ts';

/**
 * Projects the cockpit into one detached engine run.
 *
 * The sandbox plan next door describes a disposable container wrapped around a
 * single interactive session. This one describes a long-lived container holding
 * the hub and every session it goes on to spawn, which changes four things:
 * it is detached rather than attached, it publishes a port rather than only
 * consuming them, its home volume is scoped to the cockpit rather than to one
 * repository, and it mounts a set of workspaces rather than a single repo.
 */

const CONTAINER_HOME = '/doompi-home';
/**
 * One volume for the cockpit, not one per repository.
 *
 * A cockpit spans several workspaces, so there is no repository to key on. This
 * is also where `~/.doompi/web` lands, which is what makes paired passkeys and
 * the bundle signing key survive a container restart. A rotated signing key
 * would make every paired device refuse the cockpit, so the name must be
 * stable.
 */
export const COCKPIT_HOME_VOLUME = 'doompi-cockpit-home';
export const COCKPIT_LABEL = 'doompi.cockpit';
const COCKPIT_BINARY = 'doompi-web';
const LOOPBACK = '127.0.0.1';
/**
 * The cockpit binds every interface inside the container.
 *
 * A published port reaches the container's external interface, never its
 * loopback, which is the same reason `oauthCallback.ts` sets its own bind
 * address. The host side of the publish is pinned to loopback, so this is not
 * exposed beyond the machine.
 */
const CONTAINER_BIND = '0.0.0.0';
const LINUX_PLATFORM = 'linux';
const DISABLED = '0';

/** Git identity the agent commits under; no key crosses the boundary, so it cannot push. */
export interface CockpitGitIdentity {
  name: string;
  email: string;
}

export interface CockpitPlanInput {
  workspaces: readonly CockpitWorkspace[];
  /** Published on the host loopback and bound inside the container. */
  port: number;
  environment: Readonly<Record<string, string | undefined>>;
  engine: SandboxEngine;
  host: SandboxHostFacts;
  imageTag: string;
  runFlags?: readonly string[];
  broker?: SandboxPlanBroker;
  gitIdentity?: CockpitGitIdentity;
}

export interface CockpitPlan {
  imageTag: string;
  /** Full engine argv after the engine binary itself. */
  runArgs: string[];
}

/**
 * Git identity, passed as environment rather than by mounting a config.
 *
 * The agent can commit; it cannot push, because no key crosses the boundary.
 * Mounting `~/.gitconfig` would drag in whatever else it configures, and
 * forwarding an ssh agent would hand the container a live credential that
 * authenticates as the user everywhere their key reaches.
 */
function gitIdentityEnvironment(identity: CockpitGitIdentity | undefined): Record<string, string> {
  if (identity === undefined) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

export function buildCockpitPlan(input: CockpitPlanInput): CockpitPlan {
  const { engine, host, broker, imageTag, port } = input;
  if (input.workspaces.length === 0) throw new Error('A cockpit container needs at least one workspace to mount.');

  const environment: Record<string, string> = {
    ...containerEnvironment(input.environment, broker),
    ...gitIdentityEnvironment(input.gitIdentity),
    // A workspace carrying a devcontainer config would otherwise replace the
    // whole plan with an author-controlled one that can mount anything,
    // including the docker socket. That would make the containment claim false.
    [DEVCONTAINER_DISABLED_ENV]: DISABLED,
    [DOOMPI_SANDBOX_ENV]: '1',
  };
  const environmentPairs = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));

  const runArgs = [
    'run',
    // Detached, and deliberately not --rm: a container that exits on startup
    // has to survive long enough for its logs to be read. The stop path and the
    // reaper both remove it.
    '-d',
    '--label',
    `${COCKPIT_LABEL}=${String(port)}`,
    '-p',
    `${LOOPBACK}:${String(port)}:${String(port)}`,
    ...input.workspaces.flatMap((workspace) => ['-v', `${workspace.path}:${workspace.path}`]),
    '-v',
    `${COCKPIT_HOME_VOLUME}:${CONTAINER_HOME}`,
    ...(broker?.endpoint.transport === 'tcp' ? ['--add-host', `host.docker.internal:host-gateway`] : []),
    ...(broker?.endpoint.transport === 'unix' ? ['-v', `${broker.endpoint.socketDirectory}:/run/doompi`] : []),
    '-w',
    input.workspaces[0]?.path ?? CONTAINER_HOME,
    '-e',
    `HOME=${CONTAINER_HOME}`,
    ...environmentPairs.flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    ...(host.platform === LINUX_PLATFORM && host.userId !== undefined
      ? [
          '--user',
          `${String(host.userId)}:${String(host.groupId ?? host.userId)}`,
          ...(engine === 'podman' ? ['--userns=keep-id'] : []),
        ]
      : []),
    // Last before the image so a configured option wins over the defaults above
    // it, and cannot be mistaken for the image or its command.
    ...(input.runFlags ?? []),
    imageTag,
    COCKPIT_BINARY,
    '--host',
    CONTAINER_BIND,
    '--port',
    String(port),
  ];

  return { imageTag, runArgs };
}
