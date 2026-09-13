/**
 * Cockpit container harness contract.
 *
 * The sandbox harness next door provisions a container, runs one interactive
 * launch inside it, and reports the exit code. This is the other shape: a
 * detached container that outlives the call, holding the cockpit hub and every
 * session it goes on to spawn.
 *
 * The difference is worth its own contract rather than a flag. `launchSandbox`
 * returns `Promise<number>`, which cannot express "it is running, here is the
 * handle", and its credential broker is torn down as soon as that promise
 * settles. A detached cockpit needs both to outlive the call.
 *
 * Core and the cockpit resolve this dynamically from the selected composition,
 * exactly as they resolve the sandbox harness, so neither depends on a concrete
 * container technology.
 */

/** Exports subpath a layer package declares when it can host the cockpit. */
export const COCKPIT_HARNESS_EXPORT_SUBPATH = './cockpit-harness';

/** One host directory the cockpit may work in, bind-mounted at its own path. */
export interface CockpitWorkspace {
  /**
   * Absolute host path, mounted at the identical path inside the container so
   * every absolute path the cockpit already holds keeps resolving.
   */
  path: string;
}

export interface CockpitContainerRequest {
  /**
   * Directories the cockpit may create sessions in. This list is the boundary:
   * a hub inside the container cannot reach a path that is not here, which is
   * what makes "sessions only start in mounted directories" true by
   * construction rather than by a check that can be weakened later.
   */
  workspaces: readonly CockpitWorkspace[];
  /** Loopback port the cockpit is published on, and the port it binds inside. */
  port: number;
  /** Host environment the provider filters before any of it enters the container. */
  environment: NodeJS.ProcessEnv;
  /** Receives one human-readable line per provisioning decision, including image builds. */
  onProgress?: (message: string) => void;
}

export interface CockpitContainerHandle {
  /** Engine-assigned id, recorded on the host so an orphan can be reaped later. */
  readonly containerId: string;
  /** Stops the container and releases everything provisioned alongside it. */
  stop(): Promise<void>;
  /**
   * Whether the container is still running.
   *
   * The supervising process has no server of its own once it has handed over,
   * so this is what it watches: a container that died has to end the supervisor
   * with it, rather than leaving a process that owns nothing.
   */
  alive(): Promise<boolean>;
}

export type CockpitContainerStart = { ok: true; handle: CockpitContainerHandle } | { ok: false; error: string };

export interface CockpitContainerHarnessModule {
  /**
   * Builds the image if it is missing, starts the container detached, and
   * returns once the cockpit inside is answering.
   */
  startCockpitContainer(request: CockpitContainerRequest): Promise<CockpitContainerStart>;
  /**
   * Stops a container this harness started in an earlier process, named by id.
   * Resolves true when one was found and stopped.
   */
  reapCockpitContainer(containerId: string): Promise<boolean>;
}

/** Narrowing guard for a dynamically imported cockpit harness entry. */
export function isCockpitContainerHarnessModule(value: unknown): value is CockpitContainerHarnessModule {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CockpitContainerHarnessModule>;
  return typeof candidate.startCockpitContainer === 'function' && typeof candidate.reapCockpitContainer === 'function';
}
